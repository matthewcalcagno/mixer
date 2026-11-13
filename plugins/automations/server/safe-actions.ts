import { z } from "zod";
import { actionName, safeActionSchema } from "../shared/contracts.js";
import type { AutomationEvent } from "./events.js";
import { valueAt } from "./github-facts.js";

const policy = {
  max: z.literal(1),
  allowedAuthors: z.array(z.string().min(1)).min(1).max(50),
};
export const safeActions = z
  .object({
    "github.pr.approve": z.object(policy).strict().optional(),
    "github.pr.merge": z
      .object({
        ...policy,
        method: z.enum(["merge", "squash", "rebase"]).default("squash"),
        mode: z.literal("immediate").default("immediate"),
        approve: z.literal(false).optional(),
        minimumChecks: z.number().int().min(1).max(100).default(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

const proposal = z
  .object({
    version: z.literal(1),
    actions: z
      .array(
        z
          .object({
            name: actionName,
            input: z
              .object({ version: z.literal(1), decision: z.enum(["approve", "merge"]) })
              .strict(),
          })
          .strict(),
      )
      .max(1)
      .default([]),
  })
  .passthrough();

export type Action = z.output<typeof safeActionSchema>;
type Policies = z.output<typeof safeActions>;

export function prepareAction(
  output: string,
  policies: Policies,
  event?: AutomationEvent,
  apiUrl = event?.authority ?? "https://api.github.com",
): Action | undefined {
  const line = output.trimEnd().split("\n").at(-1) ?? "";
  const prefix = "MIXER_AUTOMATIONS_RESULT:";
  if (!line.startsWith(prefix)) return;
  if (line.length > 4096) throw new Error("Safe Action proposal exceeds 4 KiB.");
  const result = proposal.parse(JSON.parse(line.slice(prefix.length)));
  const [request] = result.actions;
  if (!request) return;
  const { name, input } = request;
  if (name !== `github.pr.${input.decision}`)
    throw new Error("Safe Action decision does not match its name.");
  const allowed = policies[name];
  if (!allowed) throw new Error("The workflow did not authorize this Safe Action.");
  if (event?.source !== "github" || !event.revision || !event.repository || event.externalRevision)
    throw new Error(
      "Safe Actions require a same-repository GitHub PR event with an exact revision.",
    );
  const author = valueAt(event.payload, "pull_request.user.login");
  if (
    typeof author !== "string" ||
    !allowed.allowedAuthors.some((item) => item.toLowerCase() === author.toLowerCase())
  )
    throw new Error("The PR author is outside the workflow’s Safe Action policy.");
  const merge = name === "github.pr.merge" ? policies[name] : undefined;
  return safeActionSchema.parse({
    apiUrl,
    name,
    status: "proposed",
    repository: event.repository,
    sha: event.revision,
    number: valueAt(event.payload, "pull_request.number"),
    branch: valueAt(event.payload, "pull_request.head.ref"),
    baseBranch: valueAt(event.payload, "pull_request.base.ref"),
    author,
    method: merge?.method,
    minimumChecks: merge?.minimumChecks,
  });
}

const pull = z.object({
  number: z.number(),
  state: z.string(),
  draft: z.boolean(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  user: z.object({ login: z.string() }),
  head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});
const checks = z.object({
  total_count: z.number(),
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});
const statuses = z.object({
  total_count: z.number(),
  statuses: z.array(z.object({ state: z.string() })),
});

export async function validateAction(
  action: Action,
  token: string,
  signal: AbortSignal,
  apiUrl = "https://api.github.com",
) {
  const request = githubRequest(action, token, signal, apiUrl);
  const pr = pull.parse(await request(`pulls/${action.number}`));
  const repo = action.repository.toLowerCase();
  const matches = [
    pr.number === action.number,
    pr.state === "open",
    !pr.draft,
    !pr.merged,
    pr.user.login.toLowerCase() === action.author.toLowerCase(),
    pr.head.sha === action.sha,
    pr.head.ref === action.branch,
    pr.base.ref === action.baseBranch,
    pr.head.repo.full_name.toLowerCase() === repo,
    pr.base.repo.full_name.toLowerCase() === repo,
  ];
  if (matches.includes(false))
    throw new Error("The PR changed since this run. Review it in a new run.");
  if (action.name === "github.pr.merge") {
    if (!pr.mergeable) throw new Error("GitHub has not confirmed this PR is mergeable.");
    const [checkData, statusData] = await Promise.all([
      request(`commits/${action.sha}/check-runs?per_page=100&filter=latest`).then((value) =>
        checks.parse(value),
      ),
      request(`commits/${action.sha}/status?per_page=100`).then((value) => statuses.parse(value)),
    ]);
    const successful =
      checkData.check_runs.every(
        (item) =>
          item.status === "completed" &&
          ["success", "neutral", "skipped"].includes(item.conclusion ?? ""),
      ) && statusData.statuses.every((item) => item.state === "success");
    const count = checkData.check_runs.length + statusData.statuses.length;
    if (
      !successful ||
      count < (action.minimumChecks ?? 1) ||
      checkData.total_count !== checkData.check_runs.length ||
      statusData.total_count !== statusData.statuses.length
    )
      throw new Error("The exact PR revision does not meet the configured check requirements.");
  }
}

export async function executeAction(
  action: Action,
  token: string,
  signal: AbortSignal,
  apiUrl = "https://api.github.com",
) {
  const request = githubRequest(action, token, signal, apiUrl);
  if (action.name === "github.pr.approve") {
    const result = await request(`pulls/${action.number}/reviews`, "POST", {
      event: "APPROVE",
      commit_id: action.sha,
    });
    if (valueAt(result, "state") !== "APPROVED" || valueAt(result, "commit_id") !== action.sha)
      throw new Error("GitHub did not confirm approval of the exact revision.");
    return;
  }
  const result = await request(`pulls/${action.number}/merge`, "PUT", {
    sha: action.sha,
    merge_method: action.method,
  });
  if (valueAt(result, "merged") !== true) throw new Error("GitHub did not confirm the merge.");
}

export async function reconcileAction(
  action: Action,
  token: string,
  signal: AbortSignal,
  apiUrl = "https://api.github.com",
) {
  const request = githubRequest(action, token, signal, apiUrl);
  const pr = pull.parse(await request(`pulls/${action.number}`));
  if (!sameActionTarget(action, pr)) return false;
  if (action.name === "github.pr.merge") return pr.merged;
  const identity = z
    .object({ login: z.string() })
    .parse(await githubJson(`${apiUrl.replace(/\/+$/, "")}/user`, token, signal));
  const reviews = z.array(
    z.object({ state: z.string(), commit_id: z.string(), user: z.object({ login: z.string() }) }),
  );
  let latest: z.output<typeof reviews>[number] | undefined;
  for (let page = 1; page <= 100; page++) {
    const entries = reviews.parse(
      await request(`pulls/${action.number}/reviews?per_page=100&page=${page}`),
    );
    for (const review of entries)
      if (
        review.user.login.toLowerCase() === identity.login.toLowerCase() &&
        review.state !== "PENDING"
      )
        latest = review;
    if (entries.length < 100) {
      const current = pull.parse(await request(`pulls/${action.number}`));
      return (
        sameActionTarget(action, current) &&
        latest?.state === "APPROVED" &&
        latest.commit_id === action.sha
      );
    }
  }
  throw new Error(
    "GitHub review history exceeded the reconciliation page limit. Verify the approval on GitHub.",
  );
}

function sameActionTarget(action: Action, pr: z.output<typeof pull>) {
  const repository = action.repository.toLowerCase();
  return (
    pr.number === action.number &&
    pr.head.sha === action.sha &&
    pr.head.ref === action.branch &&
    pr.base.ref === action.baseBranch &&
    pr.user.login.toLowerCase() === action.author.toLowerCase() &&
    pr.head.repo.full_name.toLowerCase() === repository &&
    pr.base.repo.full_name.toLowerCase() === repository
  );
}

function githubRequest(action: Action, token: string, signal: AbortSignal, apiUrl: string) {
  // COMPAT(automationActionApiUrl): added in v0.1.1, remove after 2027-05-01.
  // Records written before configurable API URLs could only target public GitHub.
  const reviewedApi = action.apiUrl ?? "https://api.github.com";
  const canonical = (url: string) => new URL(url).toString().replace(/\/+$/, "");
  if (canonical(reviewedApi) !== canonical(apiUrl))
    throw new Error(
      "The GitHub API authority changed since this proposal. Review it in a new run.",
    );
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(action.repository))
    throw new Error("Invalid GitHub repository.");
  return (suffix: string, method?: "POST" | "PUT", body?: object): Promise<unknown> =>
    githubJson(
      `${apiUrl.replace(/\/+$/, "")}/repos/${action.repository}/${suffix}`,
      token,
      signal,
      method,
      body,
    );
}

async function githubJson(
  url: string,
  token: string,
  signal: AbortSignal,
  method?: "POST" | "PUT",
  body?: object,
): Promise<unknown> {
  const result = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "Mixer-Automations",
    },
    ...(method && body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!result.ok) {
    await result.body?.cancel();
    throw new Error(`GitHub returned HTTP ${result.status}.`);
  }
  return result.json();
}
