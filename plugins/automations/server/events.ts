import type { z } from "zod";
import { githubFacts, valueAt } from "./github-facts.js";
import { matchesGitHubTrigger } from "./github-matcher.js";
import type { readDefinition } from "./definition.js";

type Definition = Awaited<ReturnType<typeof readDefinition>>;
type GithubType = Extract<keyof Definition["on"], `github.${string}`>;

export interface AutomationEvent {
  source: "github" | "jira" | "webhook";
  authority?: string;
  id: string;
  payload: z.output<ReturnType<typeof z.json>>;
  githubType?: GithubType;
  repository?: string;
  revision?: string;
  externalRevision?: boolean;
  endpoint?: string;
}

export function repositoryTargets(definition: Definition, event?: AutomationEvent) {
  const configured = definition.repository;
  const repositories = [configured ?? []].flat();
  if (!event?.repository) return repositories.length ? repositories : [undefined];
  return repositories.filter(
    (repository) => repository.toLowerCase() === event.repository!.toLowerCase(),
  );
}

export function matchesEvent(definition: Definition, event: AutomationEvent) {
  if (definition.disabled) return false;
  if (event.source === "github") return matchesGithub(definition, event);
  if (event.source === "jira") return !!definition.on["jira.issue"];
  const trigger = definition.on["webhook.received"];
  return (
    !!trigger &&
    (!trigger.endpoints || trigger.endpoints.some((endpoint) => endpoint === event.endpoint)) &&
    Object.entries(trigger.payload ?? {}).every(([key, values]) =>
      values.some((item) => item === valueAt(event.payload, key)),
    )
  );
}

function matchesGithub(definition: Definition, event: AutomationEvent) {
  const trigger = event.githubType && definition.on[event.githubType];
  if (!trigger || !repositoryTargets(definition, event).length) return false;
  return matchesGitHubTrigger(githubFacts(event.payload), trigger);
}
