import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineExtension, type Workspace, type WorkspaceContext } from "@mixer/automations-sdk";

const configSchema = z.object({ cleanup: z.boolean().default(true) }).strict();
const marker = ".roboplane-scratch.json";
let cleanupOrphans = (): void => {};

function targetFor(root: string, runId: string): string {
  const target = path.resolve(root, runId);
  if (path.dirname(target) !== path.resolve(root)) throw new Error("Scratch workspace run ID escapes workspace root");
  return target;
}

function assertOwned(root: string, context: WorkspaceContext, workspace: Workspace): string {
  const expected = targetFor(root, context.run.id);
  if (path.resolve(workspace.path) !== expected) throw new Error("Scratch workspace path is not owned by this run");
  return expected;
}

function hasValidMarker(target: string, runId: string): boolean {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(target, marker), "utf8")) as { version?: unknown; runId?: unknown };
    return stored.version === 1 && stored.runId === runId;
  } catch {
    return false;
  }
}

export default defineExtension({
  name: "scratch",
  version: "0.1.0",
  setup(api) {
    const config = configSchema.parse(api.config.get());

    api.workspaces.register("scratch", {
      create(context) {
        const target = targetFor(api.paths.workspaces, context.run.id);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { mode: 0o700 });
        fs.writeFileSync(path.join(target, marker), JSON.stringify({ version: 1, runId: context.run.id }));
        return { path: target, metadata: { kind: "scratch" } };
      },
      attest(context, workspace) {
        const target = assertOwned(api.paths.workspaces, context, workspace);
        const stat = fs.lstatSync(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Scratch workspace is not a real directory");
        const root = fs.realpathSync(api.paths.workspaces);
        if (path.dirname(fs.realpathSync(target)) !== root) throw new Error("Scratch workspace resolves outside workspace root");
        if (!hasValidMarker(target, context.run.id)) throw new Error("Scratch workspace provenance is invalid");
        return {
          version: 1 as const,
          kind: "directory" as const,
          path: target,
          revision: "scratch",
          clean: fs.readdirSync(target).every((name) => name === marker),
          verifiedAt: new Date().toISOString(),
        };
      },
      cleanup(context, workspace) {
        const target = assertOwned(api.paths.workspaces, context, workspace);
        if (config.cleanup && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      },
    });

    cleanupOrphans = config.cleanup ? () => {
        if (!fs.existsSync(api.paths.workspaces)) return;
        for (const entry of fs.readdirSync(api.paths.workspaces, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const target = targetFor(api.paths.workspaces, entry.name);
          if (hasValidMarker(target, entry.name)) fs.rmSync(target, { recursive: true, force: true });
        }
      } : () => {};
  },
  start() {
    // Sources and workers have not started yet, so marked directories here are
    // leftovers from an ungraceful previous daemon process.
    cleanupOrphans();
  },
});
