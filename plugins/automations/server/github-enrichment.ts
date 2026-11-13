import { z } from "zod";
import { commitHash } from "./checkout.js";
import { repositorySlug } from "./definition.js";
import type { AutomationEvent } from "./events.js";
import { valueAt } from "./github-facts.js";

const identity = z
  .object({
    number: z.number().int().positive(),
    head: z.object({
      sha: z.string().regex(commitHash),
      repo: z.object({ full_name: repositorySlug }),
    }),
    base: z.object({ repo: z.object({ full_name: repositorySlug }) }),
  })
  .passthrough();

// GitHub check_run payloads carry PR references, rather than the PR's author and draft state.
export async function enrichGithubCheck(
  event: AutomationEvent,
  token: string,
  signal: AbortSignal,
  apiUrl = "https://api.github.com",
): Promise<AutomationEvent> {
  if (event.githubType !== "github.check" || !event.repository) return event;
  const sha = valueAt(event.payload, "check_run.head_sha");
  const refs = valueAt(event.payload, "check_run.pull_requests");
  if (typeof sha !== "string" || !commitHash.test(sha) || !Array.isArray(refs) || refs.length !== 1)
    return event;
  const parsed = z.number().int().positive().safeParse(valueAt(refs[0], "number"));
  if (!parsed.success) return event;
  const repository = repositorySlug.parse(event.repository);
  const response = await fetch(
    `${apiUrl.replace(/\/+$/, "")}/repos/${repository}/pulls/${parsed.data}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "Mixer-Automations",
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub PR lookup returned HTTP ${response.status}.`);
  }
  const payload = z.record(z.string(), z.json()).parse(event.payload);
  const raw = z.record(z.string(), z.json()).parse(await response.json());
  const pr = identity.parse(raw);
  const repo = repository.toLowerCase();
  if (
    pr.number !== parsed.data ||
    pr.head.sha !== sha ||
    pr.base.repo.full_name.toLowerCase() !== repo
  )
    return event;
  const sameRepository = pr.head.repo.full_name.toLowerCase() === repo;
  return {
    ...event,
    payload: { ...payload, pull_request: raw },
    revision: sameRepository ? sha : undefined,
    externalRevision: !sameRepository,
  };
}
