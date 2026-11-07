---
name: mixer-plugin
description: Build or extend a local Mixer plugin using the shared, client, and server SDK entry points.
---

# Mixer plugins

Read `docs/plugins.md` and the relevant section of `public-docs/plugins/reference.md`
before editing a plugin. Use `plugin-examples/local-plugin` as the runtime-entry
example. Keep server code in `index.server.ts` and client code in
`index.client.tsx`; shared RPC contracts import from `@mixer/plugin`.

Plugins run with the user's permissions. Explain any new host process, filesystem,
or network access. Use the plugin project's typecheck and focused tests before
installing it with `mixer plugin install /absolute/path/to/plugin`. Do not restart
the daemon to load a plugin.

## Add a language server

Read the language-server section of `public-docs/plugins/reference.md` and copy
`plugin-examples/language-servers` for Java, Rust, C/C++, or another stdio LSP.
Register with `server.registerLanguageServer()` from `index.server.ts`; do not edit
Mixer's built-in language registry or replace the source editor. Keep only the
languages requested. The example README owns toolchain setup and launch details.
Verify real completion through the plugin registration, not merely process startup.
Do not claim support for a server's custom workflows without testing them.

## Add a composer pill

Register the pill for an active agent and its workspace. Remove the registration
when the agent leaves or the plugin unloads; retain the handle to update its label
or visibility as state changes.

```tsx
import type { PluginClientContext } from "@mixer/plugin/client";

export function addNotesPill(client: PluginClientContext, workspaceId: string, agentId: string) {
  return client.addComposerPill({
    id: "notes",
    workspaceId,
    agentId,
    button: {
      title: "Open notes",
      label: "Notes",
      icon: "File",
      behavior: {
        kind: "action",
        onPress() {
          client.openPanel("notes", { workspaceId });
        },
      },
    },
  });
}
```

Register the `notes` workspace panel separately before opening it. Use the SDK's
button descriptors rather than mounting an independent overlay in the composer.
