# Workspaces

YAML uses the same workspace selection and attestation as Markdown. All steps in a run share a workspace. Child handoffs get independent workspaces, never the parent's checkout. Relative directories are checked for traversal and symlink escapes. Disposable workspace files are not durable results; print reports into run logs or publish them explicitly.

`workspace` is optional workflow frontmatter. Mixer Automations defaults to `worktree` when `repository` is present, whether it is one repository or a list, and `scratch` when it is absent. An explicit value selects any registered workspace provider. Each run of a multi-repository workflow still receives one repository checkout.

## Scratch directories

The built-in `scratch` provider supports Jira, Linear, Trello, reporting, and other workflows that do not need source code:

```yaml
agent: codex
on:
  jira.issue:
    project: PLATFORM
```

It creates `$MIXER_AUTOMATIONS_HOME/.roboplane/workspaces/<run-id>` with owner-only directory permissions and verifies that the path and provenance marker belong to the run before starting the harness. The directory is re-attested and recursively removed after successful completion, failure, cancellation, or graceful interruption. On daemon startup, the provider removes marked scratch directories left by an ungraceful previous exit. It never removes the shared workspace root, Git mirror cache, or unmarked directories.

Scratch files are temporary and are not published automatically. Use a Safe Action or another explicit destination for durable reports. Set `extensions.scratch.cleanup` to `false` to retain scratch directories for diagnosis; retained directories are then the operator's responsibility.

## Git worktrees

The built-in `worktree` provider maintains a mirror cache and creates a disposable checkout for every run. The mirror is only a local optimization: access is serialized per repository, and if an existing mirror cannot fetch or produce the requested checkout, Mixer Automations clones a replacement from the authoritative remote and retries once. An unrecoverable remote, authentication, or replacement failure still fails workspace preparation with both failure contexts. Recovery is scoped to that repository; operators do not need to delete the complete Mixer Automations home or every cached mirror. GitHub activations check out the exact event revision when one is available.

Before the harness starts, the provider attests the actual checkout. It fails the run unless the canonical path is the run-specific directory under `$MIXER_AUTOMATIONS_HOME/.roboplane/workspaces`, the Git root and `origin` match, `HEAD` is the activated revision, and the checkout is clean. Mixer Automations records this initial attestation and a final checkout snapshot in SQLite. `mixer-automations automations inspect <run>` prints the effective path, repository, starting revision, final branch and revision, and cleanliness.

The checkout has a normal `origin` URL pointing at the activated repository. The agent can create branches and use ordinary Git commands, but the GitHub publication capability limits remote writes to the one branch owned by the run. Same-repository PRs authored by the configured account, or by an exact author allowed through `github.pullRequests.branchUpdates.allowedAuthors`, may receive guarded fast-forward pushes on their activated branch. Each confirmed successor head is recorded for later approval or merge by the same run. Other third-party and fork PR workspaces remain writable for builds and analysis while commit and publication commands are denied. Private-repository cache fetches use normal Git credentials. The trusted worktree extension can instead use its optional `cloneToken`; when that setting is absent, an exported `GITHUB_TOKEN` is also accepted for backward-compatible private-clone authentication. These credentials stay in the trusted extension process and are not forwarded to the agent harness.

After the harness exits, Mixer Automations removes the checkout by default. It also removes an incomplete run checkout when preparation fails before the harness starts. Changes that were not committed or pushed by the agent disappear. This is normal temporary-workspace behavior, not a security sandbox.

Issue and pull-request `memory.md` files are not stored in these checkouts. They live under `$MIXER_AUTOMATIONS_HOME/.roboplane/cases` and survive across fresh workspaces until 24 hours after the case closes.

Workspace extensions implement:

```ts
api.workspaces.register("custom", {
  async create(ctx) {
    return { path: "/path/to/checkout" };
  },
  async attest(ctx, workspace) {
    return {
      version: 1,
      kind: "git",
      path: workspace.path,
      repository: ctx.repository,
      revision: "<full commit SHA>",
      clean: true,
      verifiedAt: new Date().toISOString(),
    };
  },
  async cleanup(ctx, workspace) {
    // optional cleanup
  },
});
```
