import { z } from "zod";
import { githubEvent } from "./webhooks.js";
import type { AutomationEvent } from "./events.js";

const eventTypes: Record<string, string> = {
  IssuesEvent: "issues",
  PullRequestEvent: "pull_request",
  IssueCommentEvent: "issue_comment",
  PullRequestReviewEvent: "pull_request_review",
  PullRequestReviewCommentEvent: "pull_request_review_comment",
};
const repositoryEvent = z.object({
  id: z.string().max(200),
  type: z.string(),
  actor: z.object({ login: z.string() }).optional(),
  payload: z.record(z.string(), z.json()),
});
const MAX_PAGES = 3;

export async function pollGithubRepository(
  repository: string,
  token: string,
  cursor: string | undefined,
  signal: AbortSignal,
  dispatch: (event: AutomationEvent) => Promise<number>,
) {
  const events: z.output<typeof repositoryEvent>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${repository}/events?per_page=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "Mixer-Automations",
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub Events returned HTTP ${response.status} for ${repository}.`);
    }
    const entries = z.array(repositoryEvent).parse(await response.json());
    events.push(...entries);
    if (!cursor || entries.some((event) => event.id === cursor) || entries.length < 100) break;
  }
  if (!events.length) return cursor;
  if (cursor) {
    const unseen: AutomationEvent[] = [];
    for (const event of events) {
      if (event.id === cursor) break;
      if (!Object.hasOwn(eventTypes, event.type)) continue;
      const normalized = githubEvent(
        eventTypes[event.type],
        {
          ...event.payload,
          ...(event.actor ? { actor: event.actor } : {}),
          repository: { full_name: repository },
        },
        `poll:${event.id}`,
      );
      if (normalized) unseen.push(normalized);
    }
    for (const event of unseen.toReversed()) await dispatch(event);
  }
  // The first poll establishes a baseline, avoiding a burst of old runs.
  return events[0].id;
}
