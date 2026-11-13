import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "@mixer/automations-sdk";

export interface GitHubBranchCapability {
  version: 1;
  runId: string;
  publicationKey?: string;
  /** Optional for compatibility with receipts written before lifecycle GC. */
  createdAt?: string;
  finalizedAt?: string;
  lastReconciledAt?: string;
  reconciliation?: "confirmed" | "pending" | "uncertain";
  repository: string;
  mode: "new-branch" | "owned-pr" | "allowed-pr" | "review-only";
  baseRevision: string;
  baseBranch: string;
  remote: string;
  maxChangedFiles: number | null;
  allowedPrBaseBranches?: string[];
  case?: { kind: "issue" | "pr"; number: number };
  allowedBranch?: string;
  activatedRemoteSha?: string;
  expectedRemoteSha?: string;
  prNumber?: number;
  prAuthor?: string;
  /** PAT identity attested by the extension before installing the command guard. */
  authenticatedLogin?: string;
  allowedReviewCommentIds?: number[];
  confirmedAt?: string;
  prCreatedAt?: string;
  pending?: { operation: "push" | "pr-create"; branch: string; head: string; expectedRemoteSha?: string; baseBranch?: string; startedAt: string };
  published?: { branch: string; previousHead: string; head: string; confirmedAt: string };
  publicationChain?: string[];
}

const guardSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const tool = process.argv[2];
const args = process.argv.slice(3);
const configPath = process.env.MIXER_AUTOMATIONS_PUBLISH_GUARD;
if (!configPath) throw new Error("Mixer Automations publication guard configuration is missing");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const realEnv = { ...process.env, PATH: process.env.MIXER_AUTOMATIONS_REAL_PATH || process.env.PATH };
const run = (command, commandArgs, options = {}) => spawnSync(command, commandArgs, {
  cwd: options.cwd || process.cwd(), env: realEnv, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit",
});
const git = (commandArgs, cwd, allowFailure = false) => {
  const result = run("git", commandArgs, { cwd, capture: true });
  if (!allowFailure && result.status !== 0) throw new Error((result.stderr || result.stdout || "git command failed").trim());
  return result;
};
const canonical = (value) => fs.realpathSync(path.resolve(value));
const isInside = (root, value) => value === root || (!path.relative(root, value).startsWith("..") && !path.isAbsolute(path.relative(root, value)));
const readCapability = () => JSON.parse(fs.readFileSync(config.capabilityFile, "utf8"));
const writeCapability = (value) => {
  const temporary = config.capabilityFile + "." + process.pid + ".tmp";
  fs.mkdirSync(path.dirname(config.capabilityFile), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, config.capabilityFile);
};
const writeCommentReceipt = (file, value) => {
  const temporary = file + "." + process.pid + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
};
const markIssueComment = (capability) => {
  if (args.some(value => ["--edit-last", "--delete-last", "--create-if-none", "--editor", "-e"].includes(value))) {
    throw new Error("Mixer Automations issue comments require an explicit new comment body, not interactive editing or deletion");
  }
  const inputs = [];
  const remaining = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    const flag = value.split("=", 1)[0];
    if (["--body", "-b", "--body-file", "-F"].includes(flag)) {
      const supplied = value.includes("=") ? value.slice(value.indexOf("=") + 1) : args[++index];
      if (supplied === undefined) throw new Error("Mixer Automations issue comment body is missing");
      inputs.push([flag === "--body-file" || flag === "-F", supplied]);
    } else remaining.push(value);
  }
  if (inputs.length !== 1) throw new Error("Mixer Automations issue comments require exactly one --body or --body-file input");
  const [fromFile, supplied] = inputs[0];
  const body = fromFile ? fs.readFileSync(supplied === "-" ? 0 : supplied, "utf8") : supplied;
  if (!body.trim()) throw new Error("Mixer Automations issue comment body must not be empty");
  const id = randomUUID();
  const marked = body + "\n\n<!-- roboplane:" + capability.runId + ":issue-comment:" + id + " -->";
  const receipt = {
    version: 1, id, runId: capability.runId, repository: capability.repository, number: capability.case.number,
    status: "pending", bodyHash: createHash("sha256").update(marked).digest("hex"), createdAt: new Date().toISOString(),
  };
  const receiptFile = path.join(config.commentDirectory, id + ".json");
  writeCommentReceipt(receiptFile, receipt);
  // Forward a body file rather than placing potentially large comments into argv.
  const bodyFile = path.join(path.dirname(configPath), id + ".body");
  fs.writeFileSync(bodyFile, marked, { mode: 0o600 });
  args.splice(0, args.length, ...remaining, "--body-file", bodyFile);
  return { receipt, receiptFile, bodyFile };
};
const gitInvocation = () => {
  let cwd = process.cwd();
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === "-C") { cwd = path.resolve(cwd, args[index + 1] || ""); index += 2; continue; }
    if (value === "-c") { index += 2; continue; }
    if (value === "--git-dir" || value === "--work-tree" || value?.startsWith("--git-dir=") || value?.startsWith("--work-tree=")) {
      throw new Error("Mixer Automations publication guard rejects alternate Git directories and work trees");
    }
    if (value?.startsWith("-")) { index++; continue; }
    return { command: value, commandArgs: args.slice(index + 1), cwd };
  }
  return { command: undefined, commandArgs: [], cwd };
};
const option = (name) => {
  const equals = args.find((value) => value.startsWith(name + "="));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const field = (name) => {
  for (const flag of ["--field", "-f", "--raw-field", "-F"]) {
    const index = args.indexOf(flag);
    if (index >= 0 && args[index + 1]?.startsWith(name + "=")) return args[index + 1].slice(name.length + 1);
    const prefix = flag + "=" + name + "=";
    const equals = args.find((value) => value.startsWith(prefix));
    if (equals) return equals.slice(prefix.length);
  }
  return undefined;
};
const apiEndpoint = () => {
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (["--method", "-X", "--field", "-f", "--raw-field", "-F", "--input", "--header", "-H"].includes(value)) {
      index++;
      continue;
    }
    if (value?.startsWith("-")) continue;
    return value;
  }
  return undefined;
};
const exactNumber = (values, expected, label) => {
  const target = values.find((value) => /^\d+$/.test(value));
  if (!target || Number(target) !== expected) throw new Error("Mixer Automations publication guard requires the exact " + label + " number " + expected);
};
const validateWorkspace = (cwd, capability) => {
  const workspace = canonical(config.workspace);
  const effective = canonical(cwd);
  if (!isInside(workspace, effective)) throw new Error("Mixer Automations publication guard rejected a command outside the run workspace");
  const root = canonical(git(["rev-parse", "--show-toplevel"], effective).stdout.trim());
  if (root !== workspace) throw new Error("Mixer Automations publication guard rejected a different Git checkout");
  const remote = git(["remote", "get-url", "origin"], root).stdout.trim();
  if (remote !== capability.remote) throw new Error("Mixer Automations publication guard rejected a different origin remote");
  return root;
};
const validateHead = (root, capability) => {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], root).stdout;
  if (status.trim()) throw new Error("Mixer Automations publication guard requires a clean checkout before publishing");
  const head = git(["rev-parse", "HEAD"], root).stdout.trim();
  const branchResult = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root, true);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : "";
  if (!branch) throw new Error("Mixer Automations publication guard requires a named branch");
  if (git(["merge-base", "--is-ancestor", capability.baseRevision, head], root, true).status !== 0) {
    throw new Error("Mixer Automations publication guard rejected a branch that does not descend from the activated base revision");
  }
  if (["owned-pr", "allowed-pr"].includes(capability.mode) && capability.expectedRemoteSha &&
      git(["merge-base", "--is-ancestor", capability.expectedRemoteSha, head], root, true).status !== 0) {
    throw new Error("Mixer Automations publication guard rejected a non-fast-forward PR update");
  }
  const changed = git(["diff", "--name-only", "--diff-filter=ACDMRTUXB", capability.baseRevision + "..." + head], root).stdout
    .split(/\r?\n/).filter(Boolean);
  if (capability.maxChangedFiles !== null && changed.length > capability.maxChangedFiles) {
    throw new Error("Mixer Automations publication guard rejected " + changed.length + " changed files (limit " + capability.maxChangedFiles + ")");
  }
  const sensitive = changed.find((name) => /(^|\/)\.env(?:$|\.(?:local|production|development|test)$)/i.test(name));
  if (sensitive) throw new Error("Mixer Automations publication guard rejected sensitive environment file: " + sensitive);
  return { head, branch };
};
const remoteHead = (root, branch) => {
  const result = git(["ls-remote", "--heads", "origin", "refs/heads/" + branch], root, true);
  if (result.status !== 0) throw new Error("Mixer Automations publication guard could not inspect the remote branch");
  return result.stdout.trim().split(/\s+/)[0] || "";
};
const pushPlan = (commandArgs, root, capability) => {
  if (capability.mode === "review-only") throw new Error("Mixer Automations denied commits and pushes because this workflow cannot update the pull request");
  let upstream = false;
  const positional = [];
  for (let index = 0; index < commandArgs.length; index++) {
    const value = commandArgs[index];
    if (["-u", "--set-upstream"].includes(value)) { upstream = true; continue; }
    if (["--porcelain", "--quiet", "-q", "--verbose", "-v", "--no-verify"].includes(value)) continue;
    if (value.startsWith("-")) throw new Error("Mixer Automations publication guard rejected unsupported or unsafe git push option: " + value);
    positional.push(value);
  }
  if (positional.length > 2) throw new Error("Mixer Automations publication guard permits exactly one push refspec");
  const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root, true).stdout.trim();
  if (!current) throw new Error("Mixer Automations publication guard requires a named branch");
  let remote = positional[0];
  let refspec = positional[1];
  if (!remote) {
    const tracked = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root, true);
    if (tracked.status === 0 && tracked.stdout.trim().startsWith("origin/")) {
      remote = "origin";
      refspec = "HEAD:" + tracked.stdout.trim().slice("origin/".length);
    } else {
      remote = "origin";
      refspec = current;
    }
  } else if (!refspec) refspec = current;
  if (remote !== "origin") throw new Error("Mixer Automations publication guard permits pushes only to origin");
  if (refspec.startsWith("+") || refspec.startsWith(":")) throw new Error("Mixer Automations publication guard rejected force push or branch deletion");
  const parts = refspec.split(":");
  if (parts.length > 2) throw new Error("Mixer Automations publication guard rejected an invalid refspec");
  const source = parts[0];
  const destination = (parts[1] || source).replace(/^refs\/heads\//, "");
  if (!["HEAD", current, "refs/heads/" + current].includes(source)) throw new Error("Mixer Automations publication guard requires pushing the current branch HEAD");
  if (destination !== current) throw new Error("Mixer Automations publication guard requires the local and remote branch names to match");
  if (git(["check-ref-format", "--branch", destination], root, true).status !== 0) throw new Error("Mixer Automations publication guard rejected an invalid branch name");
  if (destination === capability.baseBranch) throw new Error("Mixer Automations publication guard rejected a direct push to the protected base branch " + capability.baseBranch);
  if (capability.allowedBranch && destination !== capability.allowedBranch) throw new Error("Mixer Automations publication guard permits only branch " + capability.allowedBranch);
  const observed = remoteHead(root, destination);
  const expected = capability.expectedRemoteSha || "";
  if (observed !== expected) throw new Error("Mixer Automations publication guard rejected a stale or unrelated remote branch");
  const validated = validateHead(root, capability);
  return { ...validated, destination, expected, upstream };
};
const recordPublishedHead = (capability, head) => {
  fs.mkdirSync(config.markerDirectory, { recursive: true });
  fs.writeFileSync(path.join(config.markerDirectory, head + ".json"), JSON.stringify({ runId: capability.runId, repository: capability.repository, head, expiresAt: Date.now() + 2 * 60 * 60 * 1000 }));
};
const promoteCreatedPullRequest = (capability) => {
  const pending = capability.pending;
  if (capability.mode !== "new-branch" || pending?.operation !== "pr-create" || !capability.authenticatedLogin) {
    throw new Error("Mixer Automations cannot verify newly created PR ownership without its attested identity and creation intent");
  }
  const owner = capability.repository.split("/", 1)[0];
  const endpoint = "repos/" + capability.repository + "/pulls?head=" + encodeURIComponent(owner + ":" + pending.branch) + "&state=open&per_page=100";
  const result = run("gh", ["api", "--method", "GET", endpoint], { capture: true });
  if (result.status !== 0) throw new Error("Mixer Automations could not verify the newly created PR; creation intent retained for reconciliation");
  const pullRequests = JSON.parse(result.stdout);
  if (!Array.isArray(pullRequests) || pullRequests.length !== 1) {
    throw new Error("Mixer Automations requires exactly one live PR for the newly published branch");
  }
  const pr = pullRequests[0];
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || pr.state !== "open" ||
      typeof pr.user?.login !== "string" || pr.user.login.toLowerCase() !== capability.authenticatedLogin.toLowerCase() ||
      pr.head?.repo?.full_name !== capability.repository || pr.base?.repo?.full_name !== capability.repository ||
      pr.head?.ref !== pending.branch || pr.head?.sha !== pending.head ||
      pr.base?.ref !== pending.baseBranch || capability.expectedRemoteSha !== pending.head) {
    throw new Error("Mixer Automations rejected newly created PR identity, author, branches or head");
  }
  const root = validateWorkspace(process.cwd(), capability);
  const local = validateHead(root, capability);
  if (local.branch !== pending.branch || local.head !== pending.head || remoteHead(root, pending.branch) !== pending.head) {
    throw new Error("Mixer Automations rejected a changed branch during PR creation verification");
  }
  capability.mode = "owned-pr";
  capability.prNumber = pr.number;
  capability.prAuthor = pr.user.login;
  capability.baseBranch = pending.baseBranch;
  capability.activatedRemoteSha = pending.head;
  capability.publicationChain = [pending.head];
  capability.prCreatedAt = new Date().toISOString();
  delete capability.pending;
  writeCapability(capability);
};
const guardedPush = (invocation) => {
  const capability = readCapability();
  const root = validateWorkspace(invocation.cwd, capability);
  const plan = pushPlan(invocation.commandArgs, root, capability);
  const writablePr = ["owned-pr", "allowed-pr"].includes(capability.mode);
  const chain = writablePr ? capability.publicationChain || [capability.activatedRemoteSha || plan.expected].filter(Boolean) : [];
  if (writablePr && chain[chain.length - 1] !== plan.expected) throw new Error("Mixer Automations publication guard lost the confirmed PR publication chain");
  capability.pending = { operation: "push", branch: plan.destination, head: plan.head, ...(plan.expected ? { expectedRemoteSha: plan.expected } : {}), startedAt: new Date().toISOString() };
  writeCapability(capability);
  const canonicalArgs = ["-C", root, "push", ...(plan.upstream ? ["--set-upstream"] : []), "--force-with-lease=refs/heads/" + plan.destination + ":" + plan.expected, "origin", "HEAD:refs/heads/" + plan.destination];
  const result = run("git", canonicalArgs);
  if (result.status === 0) {
    const confirmedAt = new Date().toISOString();
    capability.allowedBranch = plan.destination;
    capability.expectedRemoteSha = plan.head;
    capability.confirmedAt = confirmedAt;
    if (writablePr) {
      capability.published = { branch: plan.destination, previousHead: plan.expected, head: plan.head, confirmedAt };
      capability.publicationChain = [...chain, plan.head];
    }
    delete capability.pending;
    writeCapability(capability);
    recordPublishedHead(capability, plan.head);
  }
  return result;
};
const guardGh = () => {
  const capability = readCapability();
  const group = args[0];
  const command = args[1];
  const ensureRepository = () => {
    const repository = option("--repo") || option("-R");
    if ([option("--repo"), option("-R")].some(value => value && value !== capability.repository)) throw new Error("Mixer Automations publication guard rejected a GitHub mutation in another repository");
    if (!repository) args.push("--repo", capability.repository);
  };
  if (group === "pr" && command === "merge") throw new Error("Mixer Automations never permits autonomous pull-request merges");
  if (group === "pr" && command === "close") throw new Error("Mixer Automations publication guard rejected autonomous pull-request closure");
  if (group === "api") {
    const method = (option("--method") || option("-X") || (args[1] === "graphql" || args.some((value) => ["--field", "-f", "--raw-field", "-F", "--input"].includes(value)) ? "POST" : "GET")).toUpperCase();
    if (method !== "GET") {
      const endpoint = apiEndpoint()?.replace(/^\//, "");
      const match = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(endpoint || "");
      const pullNumber = match ? Number(match[2]) : undefined;
      const commentId = match ? Number(match[3]) : undefined;
      const body = field("body");
      const marker = commentId ? "<!-- roboplane:" + (capability.publicationKey || capability.runId) + ":reply:" + commentId + " -->" : undefined;
      if (method !== "POST" || !match || !commentId) {
        throw new Error("Mixer Automations publication guard rejects mutating gh api calls outside activated review-comment replies");
      }
      if (match[1] !== capability.repository) throw new Error("Mixer Automations review reply targets a different repository");
      if (pullNumber !== capability.prNumber) throw new Error("Mixer Automations review reply targets a different pull request");
      if (!capability.allowedReviewCommentIds?.includes(commentId)) throw new Error("Mixer Automations review reply targets a comment not authorized for this run");
      if (!body?.includes(marker)) throw new Error("Mixer Automations review reply is missing the required publication marker " + marker);
      const existing = run("gh", ["api", "repos/" + capability.repository + "/pulls/" + capability.prNumber + "/comments?per_page=100"], { capture: true });
      if (existing.status !== 0) throw new Error("Mixer Automations publication guard could not check existing review replies");
      const comments = JSON.parse(existing.stdout || "[]");
      if (comments.some((comment) => typeof comment.body === "string" && comment.body.includes(marker))) {
        return { capability, deduplicated: true };
      }
    }
  }
  if (group === "pr" && command === "create") {
    if (capability.mode !== "new-branch" || capability.prNumber) throw new Error("Mixer Automations permits PR creation only from a newly claimed workflow branch");
    if (capability.pending?.operation === "pr-create") throw new Error("Mixer Automations requires reconciliation of the previous PR creation before another attempt");
    if (!capability.authenticatedLogin) throw new Error("Mixer Automations PR creation requires an attested PAT identity");
    const repository = option("--repo");
    const base = option("--base");
    const requestedHead = option("--head");
    if (repository && repository !== capability.repository) throw new Error("Mixer Automations publication guard rejected a PR for another repository");
    const allowedBases = new Set([capability.baseBranch, ...(capability.allowedPrBaseBranches ?? [])]);
    if (base && !allowedBases.has(base)) throw new Error("Mixer Automations publication guard rejected an unexpected PR base branch");
    if (!capability.allowedBranch || !capability.expectedRemoteSha) throw new Error("Mixer Automations requires a confirmed branch push before creating a PR");
    if (requestedHead && requestedHead !== capability.allowedBranch) throw new Error("Mixer Automations publication guard rejected an unexpected PR head branch");
    if (!repository) args.push("--repo", capability.repository);
    if (!base) args.push("--base", capability.baseBranch);
    if (!requestedHead) args.push("--head", capability.allowedBranch);
    const root = validateWorkspace(process.cwd(), capability);
    const validated = validateHead(root, capability);
    if (validated.branch !== capability.allowedBranch || validated.head !== capability.expectedRemoteSha || remoteHead(root, validated.branch) !== validated.head) {
      throw new Error("Mixer Automations publication guard requires the claimed branch head to be published before creating a PR");
    }
    capability.pending = { operation: "pr-create", branch: validated.branch, head: validated.head, expectedRemoteSha: validated.head, baseBranch: base || capability.baseBranch, startedAt: new Date().toISOString() };
    writeCapability(capability);
    return { capability, post: "pr-create" };
  }
  if (group === "pr" && ["edit", "ready"].includes(command)) {
    if (capability.mode !== "owned-pr" || !capability.prNumber) throw new Error("Mixer Automations permits PR edits and readiness changes only on verified PAT-authored pull requests");
    if (args.includes("--base") || args.some((value) => value.startsWith("--base="))) throw new Error("Mixer Automations publication guard rejects changing a PR base branch");
    exactNumber(args.slice(2), capability.prNumber, "pull request");
    ensureRepository();
  }
  if (group === "pr" && ["comment", "review"].includes(command)) {
    if (!capability.prNumber) throw new Error("Mixer Automations publication guard has no activated pull request");
    exactNumber(args.slice(2), capability.prNumber, "pull request");
    ensureRepository();
  }
  if (group === "issue" && ["comment", "edit", "close", "reopen"].includes(command)) {
    if (!capability.case) throw new Error("Mixer Automations publication guard has no activated issue or pull request");
    if (capability.case.kind === "pr" && command !== "comment") throw new Error("Mixer Automations review runs may only comment through the issue conversation endpoint");
    exactNumber(args.slice(2), capability.case.number, capability.case.kind);
    ensureRepository();
    if (command === "comment" && capability.case.kind === "issue") {
      return { capability, post: "issue-comment", ...markIssueComment(capability) };
    }
  }
  return { capability };
};

try {
  if (tool === "git") {
    const invocation = gitInvocation();
    const capability = readCapability();
    if (capability.mode === "review-only" && ["commit", "commit-tree", "merge", "cherry-pick", "rebase", "am"].includes(invocation.command)) {
      throw new Error("Mixer Automations denied commits because this workflow cannot update the pull request");
    }
    if (invocation.command === "remote" && invocation.commandArgs[0] === "set-url") throw new Error("Mixer Automations publication guard rejects changing remotes");
    if (invocation.command === "config" && invocation.commandArgs.some((value) => /^remote\.origin\./i.test(value))) throw new Error("Mixer Automations publication guard rejects changing origin configuration");
    if (invocation.command === "push") {
      const result = guardedPush(invocation);
      process.exit(typeof result.status === "number" ? result.status : 1);
    }
  } else if (tool === "gh") {
    const guarded = guardGh();
    if (guarded.deduplicated) process.exit(0);
    const result = run(tool, args, { capture: guarded.post === "issue-comment" });
    if (guarded.post === "issue-comment") {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      fs.rmSync(guarded.bodyFile, { force: true });
      if (result.status === 0) {
        let url;
        try { url = new URL(result.stdout.trim()); } catch { /* retain the intent when confirmation is unavailable */ }
        const match = url?.pathname === "/" + guarded.receipt.repository + "/issues/" + guarded.receipt.number && /^#issuecomment-(\d+)$/.exec(url.hash);
        const commentId = match ? Number(match[1]) : undefined;
        if (Number.isSafeInteger(commentId) && commentId > 0) {
          writeCommentReceipt(guarded.receiptFile, { ...guarded.receipt, status: "confirmed", commentId });
        }
      }
    }
    if (result.status === 0 && guarded.post === "pr-create") {
      promoteCreatedPullRequest(guarded.capability);
    }
    process.exit(typeof result.status === "number" ? result.status : 1);
  }
} catch (error) {
  process.stderr.write("roboplane: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(73);
}
const result = run(tool, args);
process.exit(typeof result.status === "number" ? result.status : 1);
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function capabilityPath(stateDirectory: string, runId: string): string {
  return path.join(stateDirectory, "github-branch-capabilities", "runs", `${runId}.json`);
}

export function readRunCapability(stateDirectory: string, runId: string): GitHubBranchCapability | undefined {
  const file = capabilityPath(stateDirectory, runId);
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as GitHubBranchCapability; }
  catch { return undefined; }
}

export function writeRunCapability(stateDirectory: string, capability: GitHubBranchCapability): void {
  const file = capabilityPath(stateDirectory, capability.runId);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, JSON.stringify(capability), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function installPublishGuard(options: {
  workspace: Workspace;
  stateDirectory: string;
  capability: GitHubBranchCapability;
}): void {
  options.capability.createdAt ??= new Date().toISOString();
  options.capability.reconciliation ??= "pending";
  if (["owned-pr", "allowed-pr"].includes(options.capability.mode) && options.capability.expectedRemoteSha) {
    options.capability.activatedRemoteSha ??= options.capability.expectedRemoteSha;
    options.capability.publicationChain ??= [options.capability.activatedRemoteSha];
  }
  const directory = path.join(options.workspace.path, ".git", "roboplane-guard");
  const bin = path.join(directory, "bin");
  const markerDirectory = path.join(options.stateDirectory, "github-published-heads", options.capability.repository.replace("/", "--"));
  const capabilityFile = capabilityPath(options.stateDirectory, options.capability.runId);
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(capabilityFile), { recursive: true, mode: 0o700 });
  const script = path.join(directory, "guard.mjs");
  const configuration = path.join(directory, "config.json");
  writeRunCapability(options.stateDirectory, options.capability);
  fs.writeFileSync(script, guardSource, { mode: 0o700 });
  fs.writeFileSync(configuration, JSON.stringify({
    workspace: options.workspace.path, capabilityFile, markerDirectory,
    commentDirectory: path.join(options.stateDirectory, "github-published-comments"),
  }));
  for (const tool of ["git", "gh"] as const) {
    const unix = path.join(bin, tool);
    fs.writeFileSync(unix, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} ${tool} "$@"\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" ${tool} %*\r\n`);
  }
  const originalPath = process.env.PATH ?? "";
  options.workspace.environment = {
    ...options.workspace.environment,
    PATH: `${bin}${path.delimiter}${originalPath}`,
    MIXER_AUTOMATIONS_REAL_PATH: originalPath,
    MIXER_AUTOMATIONS_PUBLISH_GUARD: configuration,
  };
}

export function hasPublishedHeadMarker(stateDirectory: string, repository: string, head: string, now = Date.now()): boolean {
  const marker = path.join(stateDirectory, "github-published-heads", repository.replace("/", "--"), `${head}.json`);
  if (!fs.existsSync(marker)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8")) as { repository?: string; head?: string; expiresAt?: number };
    const valid = value.repository === repository && value.head === head && typeof value.expiresAt === "number" && value.expiresAt >= now;
    if (!valid) fs.rmSync(marker, { force: true });
    return valid;
  } catch {
    fs.rmSync(marker, { force: true });
    return false;
  }
}
