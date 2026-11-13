import fs from "node:fs";
import path from "node:path";
import type { ExtensionState, JsonValue } from "@mixer/automations-sdk";
import type { GitHubCase } from "./memory.js";
import type { GitHubBranchCapability } from "./publication.js";

export const githubCaseRetentionMs = 24 * 60 * 60 * 1_000;
export const githubReceiptRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export type GitHubGarbageKind = "case-memory" | "case-capability" | "case-closure" | "run-receipt" | "run-capability" | "published-head" | "self-marker" | "work-receipt";

export interface GitHubGarbageCandidate {
  kind: GitHubGarbageKind;
  identifier: string;
  reason: string;
  bytes: number;
  group?: string;
  target: { type: "state"; key: string; expected: JsonValue } |
    { type: "file"; path: string; size: number; mtimeMs: number } |
    { type: "case-directory"; path: string; memoryPath: string; size: number; mtimeMs: number };
}

export interface GitHubGarbageSkipped {
  kind: GitHubGarbageKind;
  identifier: string;
  reason: string;
}

export interface GitHubGarbagePlan {
  createdAt: string;
  candidates: GitHubGarbageCandidate[];
  skipped: GitHubGarbageSkipped[];
  bytes: number;
}

export interface LiveGitHubCaseState {
  state: "open" | "closed";
  linkedPullRequestOpen?: boolean;
}

interface PlanOptions {
  state: ExtensionState;
  stateDirectory: string;
  caseRoot: string;
  verifyCase(item: GitHubCase, capability?: GitHubBranchCapability): Promise<LiveGitHubCaseState>;
  now?: number;
}

const closedPattern = /^case-memory:closed:([^:]+\/[^:]+):(issue|pr):(\d+)$/;

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function parsedCapability(value: unknown): GitHubBranchCapability | undefined {
  if (!value || typeof value !== "object") return undefined;
  const capability = value as Partial<GitHubBranchCapability>;
  return capability.version === 1 && typeof capability.runId === "string" && typeof capability.repository === "string"
    ? capability as GitHubBranchCapability : undefined;
}

function caseFromClosedKey(key: string): GitHubCase | undefined {
  const match = closedPattern.exec(key);
  if (!match) return undefined;
  const number = Number(match[3]);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { repository: match[1]!, kind: match[2] as GitHubCase["kind"], number };
}

function caseMemoryPath(root: string, item: GitHubCase): string {
  const [owner, repository] = item.repository.split("/");
  return path.join(root, owner!, repository!, item.kind, String(item.number), "memory.md");
}

function candidateForState(kind: GitHubGarbageKind, key: string, value: JsonValue, reason: string, group?: string): GitHubGarbageCandidate {
  return { kind, identifier: key, reason, bytes: Buffer.byteLength(stable(value)), ...(group ? { group } : {}), target: { type: "state", key, expected: value } };
}

function safeStat(file: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(file);
    return stat.isSymbolicLink() ? undefined : stat;
  } catch { return undefined; }
}

function receiptAge(capability: GitHubBranchCapability, stat: fs.Stats, now: number): number {
  const timestamp = capability.finalizedAt ?? capability.lastReconciledAt ?? capability.confirmedAt ?? capability.prCreatedAt ?? capability.createdAt;
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return now - (Number.isFinite(parsed) ? parsed : stat.mtimeMs);
}

export async function planGitHubGarbageCollection(options: PlanOptions): Promise<GitHubGarbagePlan> {
  const now = options.now ?? Date.now();
  const candidates: GitHubGarbageCandidate[] = [];
  const skipped: GitHubGarbageSkipped[] = [];

  for (const entry of options.state.entries("case-memory:closed:")) {
    const item = caseFromClosedKey(entry.key);
    if (!item || typeof entry.value !== "string") {
      skipped.push({ kind: "case-closure", identifier: entry.key, reason: "malformed closure record" });
      continue;
    }
    const closedAt = Date.parse(entry.value);
    if (!Number.isFinite(closedAt) || now - closedAt < githubCaseRetentionMs) continue;
    const capabilityKey = `branch-capability:${item.repository}:${item.kind}:${item.number}`;
    const group = `case:${item.repository}:${item.kind}:${item.number}`;
    const capabilityValue = options.state.get<JsonValue>(capabilityKey);
    const capability = parsedCapability(capabilityValue);
    let live: LiveGitHubCaseState;
    try { live = await options.verifyCase(item, capability); }
    catch (error) {
      skipped.push({ kind: "case-closure", identifier: entry.key, reason: `live verification failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (live.state === "open") {
      candidates.push(candidateForState("case-closure", entry.key, entry.value, "case is live-open; cancel stale closure"));
      continue;
    }
    if (live.linkedPullRequestOpen) {
      skipped.push({ kind: "case-capability", identifier: capabilityKey, reason: "linked pull request remains open" });
      continue;
    }
    const memoryPath = caseMemoryPath(options.caseRoot, item);
    let rawMemory: fs.Stats | undefined;
    try { rawMemory = fs.lstatSync(memoryPath); } catch { /* absent memory is valid */ }
    if (rawMemory && (!rawMemory.isFile() || rawMemory.isSymbolicLink())) {
      skipped.push({ kind: "case-memory", identifier: memoryPath, reason: "case memory is not a regular file" });
      continue;
    }
    const memory = safeStat(memoryPath);
    if (memory?.isFile()) {
      candidates.push({
        kind: "case-memory", identifier: memoryPath, reason: "case remained closed past retention", bytes: memory.size,
        group,
        target: { type: "case-directory", path: path.dirname(memoryPath), memoryPath, size: memory.size, mtimeMs: memory.mtimeMs },
      });
    }
    if (capabilityValue !== undefined) candidates.push(candidateForState("case-capability", capabilityKey, capabilityValue, "case remained closed past retention", group));
    candidates.push(candidateForState("case-closure", entry.key, entry.value, "case remained closed past retention", group));
  }

  const receiptRoot = path.join(options.stateDirectory, "github-branch-capabilities", "runs");
  if (fs.existsSync(receiptRoot)) {
    for (const entry of fs.readdirSync(receiptRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(receiptRoot, entry.name);
      const stat = safeStat(file);
      if (!stat?.isFile()) {
        skipped.push({ kind: "run-receipt", identifier: file, reason: "receipt is not a regular file" });
        continue;
      }
      let capability: GitHubBranchCapability | undefined;
      try { capability = parsedCapability(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* retained below */ }
      if (!capability) {
        skipped.push({ kind: "run-receipt", identifier: file, reason: "malformed receipt retained for manual inspection" });
        continue;
      }
      if (capability.pending || capability.reconciliation === "uncertain") {
        skipped.push({ kind: "run-receipt", identifier: capability.runId, reason: "publication outcome is unresolved" });
        continue;
      }
      if (!capability.finalizedAt || capability.reconciliation !== "confirmed" || receiptAge(capability, stat, now) < githubReceiptRetentionMs) continue;
      candidates.push({
        kind: "run-receipt", identifier: capability.runId, reason: "confirmed finalized receipt passed retention", bytes: stat.size,
        target: { type: "file", path: file, size: stat.size, mtimeMs: stat.mtimeMs },
      });
      const key = `branch-capability:run:${capability.runId}`;
      const value = options.state.get<JsonValue>(key);
      if (value !== undefined) candidates.push(candidateForState("run-capability", key, value, "confirmed finalized receipt passed retention"));
    }
  }

  const markerRoot = path.join(options.stateDirectory, "github-published-heads");
  if (fs.existsSync(markerRoot)) {
    for (const repository of fs.readdirSync(markerRoot, { withFileTypes: true })) {
      if (!repository.isDirectory()) continue;
      const directory = path.join(markerRoot, repository.name);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(directory, entry.name);
        const stat = safeStat(file);
        if (!stat?.isFile()) continue;
        let expired = true;
        try {
          const marker = JSON.parse(fs.readFileSync(file, "utf8")) as { expiresAt?: unknown };
          expired = typeof marker.expiresAt !== "number" || marker.expiresAt < now;
        } catch { expired = true; }
        if (expired) candidates.push({
          kind: "published-head", identifier: file, reason: "published-head suppression marker expired or malformed", bytes: stat.size,
          target: { type: "file", path: file, size: stat.size, mtimeMs: stat.mtimeMs },
        });
      }
    }
  }

  for (const entry of [...options.state.entries("self:"), ...options.state.entries("mutation:")]) {
    const expiresAt = typeof entry.value === "string" ? Date.parse(entry.value) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt < now) candidates.push(candidateForState("self-marker", entry.key, entry.value, "self-event suppression marker expired or malformed"));
  }
  for (const entry of options.state.entries("work:completed:")) {
    const value = entry.value;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.expiresAt === "number" && value.expiresAt <= now) {
      candidates.push(candidateForState("work-receipt", entry.key, value, "snapshot work receipt expired"));
    }
  }

  candidates.sort((a, b) => a.identifier.localeCompare(b.identifier) || a.kind.localeCompare(b.kind));
  skipped.sort((a, b) => a.identifier.localeCompare(b.identifier) || a.kind.localeCompare(b.kind));
  return { createdAt: new Date(now).toISOString(), candidates, skipped, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0) };
}

export function applyGitHubGarbageCollection(plan: GitHubGarbagePlan, options: Pick<PlanOptions, "state" | "stateDirectory" | "caseRoot">): { removed: number; bytes: number; skipped: GitHubGarbageSkipped[] } {
  let removed = 0;
  let bytes = 0;
  const skipped: GitHubGarbageSkipped[] = [];
  const roots = [path.resolve(options.stateDirectory), path.resolve(options.caseRoot)];
  const validate = (candidate: GitHubGarbageCandidate): string | undefined => {
    const target = candidate.target;
    try {
      if (target.type === "state") {
        const current = options.state.get<JsonValue>(target.key);
        if (current === undefined || stable(current) !== stable(target.expected)) throw new Error("state changed after planning");
      } else {
        const absolute = path.resolve(target.path);
        const root = roots.find((item) => absolute !== item && !path.relative(item, absolute).startsWith("..") && !path.isAbsolute(path.relative(item, absolute)));
        if (!root) throw new Error("target is outside managed roots");
        let current = root;
        for (const segment of path.relative(root, absolute).split(path.sep)) {
          current = path.join(current, segment);
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error("target path contains a symbolic link");
        }
        if (target.type === "file") {
          const stat = fs.lstatSync(absolute);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== target.size || stat.mtimeMs !== target.mtimeMs) throw new Error("file changed after planning");
        } else {
          const memory = fs.lstatSync(target.memoryPath);
          const entries = fs.readdirSync(absolute);
          if (!memory.isFile() || memory.isSymbolicLink() || memory.size !== target.size || memory.mtimeMs !== target.mtimeMs || entries.length !== 1 || entries[0] !== "memory.md") {
            throw new Error("case directory changed after planning");
          }
        }
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const validation = new Map<GitHubGarbageCandidate, string | undefined>();
  const blockedGroups = new Set<string>();
  for (const candidate of plan.candidates) {
    const error = validate(candidate);
    validation.set(candidate, error);
    if (error && candidate.group) blockedGroups.add(candidate.group);
  }
  for (const candidate of plan.candidates) {
    const error = validation.get(candidate) ?? (candidate.group && blockedGroups.has(candidate.group) ? "related target changed after planning" : undefined);
    if (error) {
      skipped.push({ kind: candidate.kind, identifier: candidate.identifier, reason: error });
      continue;
    }
    const target = candidate.target;
    try {
      if (target.type === "state") options.state.delete(target.key);
      else if (target.type === "file") fs.rmSync(target.path);
      else fs.rmSync(target.path, { recursive: true });
      removed++;
      bytes += candidate.bytes;
    } catch (error) {
      skipped.push({ kind: candidate.kind, identifier: candidate.identifier, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, bytes, skipped };
}
