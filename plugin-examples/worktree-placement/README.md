# Worktree placement

Place worktrees next to their source checkout, using the repository directory name and branch.
For `/home/me/src/mixer` on branch `feature/x`, the new worktree is
`/home/me/src/mixer.feature-x`. Slashes in branch names become hyphens.

Install on Mixer 0.14.0-beta.1 or newer with plugins enabled:

```bash
mixer plugin install /absolute/path/to/plugin-examples/worktree-placement
```

The plugin is one file, `index.server.ts`:

```ts
import { basename, dirname, join } from "node:path";
import type { PluginServerContext } from "@mixer/plugin/server";

export default function contribute(server: PluginServerContext) {
  return server.addHook("worktree.create.before", async ({ request }) => ({
    ...request,
    path: join(
      dirname(request.sourceCheckout),
      `${basename(request.sourceCheckout)}.${request.branch.replaceAll("/", "-")}`,
    ),
  }));
}
```

Mixer validates the returned path and refuses an existing one. It creates, lists, restores,
and removes the worktree through the normal workspace workflow. Restoring uses the recorded
path without running the hook. Git can choose a unique branch name after this hook runs;
the path retains the branch name received by the hook.

See [worktree.create.before](../../public-docs/plugins/hooks.md#worktreecreatebefore)
for the request fields and validation rules.
