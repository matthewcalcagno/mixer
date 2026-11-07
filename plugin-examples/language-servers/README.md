# Language-server plugin

Copy this directory for a local language pack. Keep the registrations you need in
`server/servers.ts` and edit their `command` arrays to point to executables installed on
the workspace host. `index.server.ts` needs no client entry or editor replacement.

- Java uses Eclipse JDT LS's `jdtls` wrapper and a compatible JDK on PATH or
  `JAVA_HOME`. Its configuration and indexes use `${serverData}`, isolated by
  workspace and provider. The sample starts the JVM with a 128 MiB initial heap
  and 1 GiB maximum heap; adjust these for your project.
- Rust uses `rust-analyzer`. Install the Rust toolchain and project dependencies
  separately for Cargo, standard-library, and build-script support.
- C/C++ uses `clangd`. Provide `compile_commands.json` or `.clangd` compiler flags
  for projects whose includes/options differ from compiler defaults.

On a Mixer build containing the extensible language-service host:

```bash
mixer plugin install /absolute/path/to/language-servers
```

Enable custom plugins in Mixer if they are disabled, then open a matching source
file. A missing executable produces an install/configuration hint. Reload the
plugin after changing launch configuration; do not restart the main daemon.
Nothing is downloaded or started merely by loading this plugin. A language server
starts when a matching editor opens and stops when its last channel closes.

For another language, copy one registration and change its ID, label, document
selectors, command, and server configuration. New language IDs and filename patterns
work without a bundled syntax grammar; syntax highlighting is a separate feature.
Servers must speak LSP over stdin/stdout. TCP-only servers need a stdio adapter.
Custom protocol extensions and advanced server-specific workflows need explicit
integration; registering a server does not implement its entire VS Code extension.

See [the API reference](../../public-docs/plugins/reference.md#language-servers)
for timeouts, settings, extension declarations, and virtual dependency documents.

## Verify a server

The existing plugin runtime suite has opt-in real-server checks. From
`packages/server`, set `MIXER_TEST_JDTLS`, `MIXER_TEST_RUST_ANALYZER`, and
`MIXER_TEST_CLANGD` to executable paths, then run:

```bash
npx vitest run src/server/plugins/runtime.posix.test.ts --testNamePattern 'runs real|language-servers plugin example' --bail=1
```

Unset executable paths skip those language cases. These checks exercise plugin
loading, discovery, initialization, and completion; Java also reads a JDK dependency
source. Rust uses an explicit `rust-project.json` fixture, so it does not establish
Cargo or build-script compatibility. Tests never install toolchains automatically.
