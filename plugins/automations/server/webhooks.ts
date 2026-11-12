import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { commitHash } from "./checkout.js";
import { repositorySlug } from "./definition.js";
import type { AutomationEvent } from "./events.js";

const maxBody = 256 * 1024;
const githubTypes = {
  issues: "github.issue",
  pull_request: "github.pull-request",
  issue_comment: "github.issue.comment",
  pull_request_review: "github.pr.review",
  pull_request_review_comment: "github.pr.comment",
  check_run: "github.check",
} as const;

function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep the connection open long enough to send the HTTP error on oversize requests.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBody) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const githubPayload = z.object({
  repository: z.object({ full_name: repositorySlug }),
  pull_request: z
    .object({
      head: z.object({
        sha: z.string().regex(commitHash),
        repo: z.object({ full_name: repositorySlug }).nullable(),
      }),
    })
    .optional(),
});

export function githubEvent(
  name: string,
  payload: AutomationEvent["payload"],
  id: string,
): AutomationEvent | null {
  if (!Object.hasOwn(githubTypes, name)) return null;
  const parsed = githubPayload.parse(payload);
  const repository = parsed.repository.full_name;
  const head = parsed.pull_request?.head;
  // Fork PRs can trigger analysis but never select the fork revision for local execution.
  const revision =
    head?.repo?.full_name.toLowerCase() === repository.toLowerCase() ? head?.sha : undefined;
  return {
    source: "github",
    id,
    githubType: githubTypes[name as keyof typeof githubTypes],
    repository,
    revision,
    externalRevision: !!head && !revision,
    payload,
  };
}

function matchesSignature(
  signature: string | string[] | undefined,
  body: Buffer,
  secret: string | undefined,
) {
  if (!secret || typeof signature !== "string") return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return equal(signature, expected);
}

export function startWebhooks(
  port: number,
  bearer: string | undefined,
  githubSecret: string | undefined,
  dispatch: (event: AutomationEvent) => Promise<number>,
) {
  function send(response: ServerResponse, status: number, accepted?: number) {
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(accepted === undefined ? {} : { accepted }));
  }
  async function receive(input: IncomingMessage, response: ServerResponse) {
    if (input.method !== "POST") return send(response, 405);
    const path = (input.url ?? "").split("?")[0];
    const github = path === "/webhooks/github";
    const endpoint = /^\/webhooks\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/.exec(path)?.[1];
    if (!endpoint) return send(response, 404);
    if (
      github
        ? !githubSecret
        : !bearer || !equal(input.headers.authorization ?? "", `Bearer ${bearer}`)
    )
      return send(response, 401);
    const raw = await readBody(input);
    if (!raw) return send(response, 413);
    if (github && !matchesSignature(input.headers["x-hub-signature-256"], raw, githubSecret))
      return send(response, 401);
    let event: AutomationEvent | null;
    try {
      const payload = z.json().parse(JSON.parse(raw.toString("utf8")));
      const id = input.headers["x-delivery-id"];
      if (!github && (typeof id !== "string" || !/^[\w.-]{1,200}$/.test(id)))
        return send(response, 400);
      event = github
        ? githubEvent(
            String(input.headers["x-github-event"] ?? ""),
            payload,
            createHash("sha256")
              .update(String(input.headers["x-github-event"] ?? ""))
              .update(raw)
              .digest("hex"),
          )
        : { source: "webhook", id: `${endpoint}:${id}`, endpoint, payload };
    } catch {
      return send(response, 400);
    }
    if (!event) return send(response, 202, 0);
    return send(response, 202, await dispatch(event));
  }

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      void receive(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed) send(response, 503);
      });
    },
  );
  server.maxConnections = 32;
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", (error) =>
        console.warn("Automations webhook listener failed", error.message),
      );
      resolve(server);
    });
  });
}
