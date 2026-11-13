import fs from "node:fs";
import path from "node:path";
import type { Event, ExtensionState } from "@mixer/automations-sdk";
import type { GitHubEventData } from "./matcher.js";

const repositoryPattern = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export interface GitHubCase {
  repository: string;
  kind: "issue" | "pr";
  number: number;
}

export function caseForEvent(event: Event | undefined): GitHubCase | undefined {
  if (!event?.repository || !repositoryPattern.test(event.repository)) return undefined;
  const data = event.data as GitHubEventData;
  if (!Number.isInteger(data.number) || data.number! <= 0) return undefined;
  const pullRequest = data.isPullRequest === true || event.type === "github.pull-request" || event.type.startsWith("github.pr.");
  if (!pullRequest && event.type !== "github.issue" && event.type !== "github.issue.comment") return undefined;
  return { repository: event.repository, kind: pullRequest ? "pr" : "issue", number: data.number! };
}

export function caseKey(item: GitHubCase): string {
  return `${item.repository}:${item.kind}:${item.number}`;
}

export class GitHubCaseMemory {
  constructor(
    private readonly root: string,
    private readonly state: ExtensionState,
    private readonly now: () => number = Date.now,
  ) {}

  path(item: GitHubCase): string {
    const match = repositoryPattern.exec(item.repository);
    if (!match) throw new Error(`Invalid GitHub case repository: ${item.repository}`);
    return path.join(this.root, match[1]!, match[2]!, item.kind, String(item.number), "memory.md");
  }

  load(item: GitHubCase): { path: string; contents: string } {
    const file = this.path(item);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`GitHub case memory is not a regular file: ${file}`);
    if (stat.size > 64 * 1024) throw new Error(`GitHub case memory exceeds 64 KiB: ${file}`);
    return { path: file, contents: fs.readFileSync(file, "utf8") };
  }

  observe(event: Event): void {
    const item = caseForEvent(event);
    if (!item) return;
    const action = (event.data as GitHubEventData).action;
    const key = this.closedKey(item);
    if (action === "closed") this.state.set(key, event.timestamp || new Date(this.now()).toISOString());
    else if (action === "opened" || action === "reopened") this.state.delete(key);
  }

  private closedKey(item: GitHubCase): string {
    return `case-memory:closed:${caseKey(item)}`;
  }
}

export class GitHubCaseLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(item: GitHubCase, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const key = caseKey(item);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);
    try {
      if (signal) await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        void previous.then(resolve, resolve).finally(() => signal.removeEventListener("abort", aborted));
        if (signal.aborted) aborted();
      });
      else await previous.catch(() => {});
    } catch (error) {
      releaseGate();
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    };
  }
}
