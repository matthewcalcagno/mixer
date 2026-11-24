import type { GitFailure } from "../shared/git.js";

export function redactGitOutput(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@");
}

export class GitCommandError extends Error {
  readonly command: string;
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    output: string,
  ) {
    super(redactGitOutput(output) || `Git exited with ${exitCode}`);
    // Commit messages and patch input can contain private text unrelated to diagnostics.
    const messageIndex = args.indexOf("-m");
    const diagnosticArgs = messageIndex < 0 ? args : args.slice(0, messageIndex);
    this.command = redactGitOutput(["git", ...diagnosticArgs].join(" "));
    this.name = "GitCommandError";
  }
}

export function describeGitFailure(error: unknown, conflict = false): GitFailure {
  const message = redactGitOutput(error instanceof Error ? error.message : "Git operation failed.");
  const command = error instanceof GitCommandError ? error.command : undefined;
  const base = { message, conflict, command };
  if (conflict) return { ...base, code: "conflict" };
  if (
    /resolve merge conflicts before committing|resolve conflict markers in .+ before staging|committing is not possible because you have unmerged files/i.test(
      message,
    )
  )
    return { ...base, conflict: true, code: "conflict" };
  if (/previous cherry-pick is now empty|nothing to commit.*cherry-pick/is.test(message))
    return { ...base, code: "empty-cherry-pick" };
  if (
    /Authentication failed|could not read (?:Username|Password)|Permission denied \(publickey\)|terminal prompts disabled|invalid username or (?:password|token)/i.test(
      message,
    )
  )
    return { ...base, code: "authentication" };
  if (
    /Author identity unknown|unable to auto-detect email address|empty ident name|tell me who you are|no (?:name|email) was given/i.test(
      message,
    )
  )
    return { ...base, code: "identity" };
  if (/\[rejected\].*\((?:non-fast-forward|fetch first)\)/i.test(message))
    return { ...base, code: "push-rejected" };
  if (
    /would be overwritten by (?:merge|checkout)|commit or stash|commit your changes or stash|cannot (?:pull|rebase).*unstaged changes|index contains uncommitted changes/i.test(
      message,
    )
  )
    return { ...base, code: "local-changes" };
  if (
    /Could not resolve (?:host|hostname)|Failed to connect|Connection (?:timed out|refused|reset)|Network is unreachable|unable to access.*(?:502|503|504)/i.test(
      message,
    )
  )
    return { ...base, code: "network" };
  if (
    error instanceof GitCommandError &&
    /^(?:commit|merge|rebase|cherry-pick)$/.test(error.args[0]) &&
    /husky|lint-staged|(?:pre-commit|commit-msg|pre-merge-commit|prepare-commit-msg|pre-rebase) hook|hook (?:failed|declined|exited)/i.test(
      message,
    )
  )
    return { ...base, code: "hook" };
  return { ...base, code: "unknown" };
}
