import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => path.join(root, "packages", name, "src", "index.ts");

export default defineConfig({
  // Integration tests launch real Git, CLI, and daemon processes. Bound CPU oversubscription.
  test: { maxWorkers: 4 },
  resolve: {
    alias: {
      "@mixer/automations-sdk": source("sdk"),
      "@roboplane/core": source("core"),
      "@roboplane/extension-claude": source("extension-claude"),
      "@roboplane/extension-codex": source("extension-codex"),
      "@roboplane/extension-copilot": source("extension-copilot"),
      "@roboplane/extension-container": source("extension-container"),
      "@roboplane/extension-evaluations": source("extension-evaluations"),
      "@roboplane/extension-github": source("extension-github"),
      "@roboplane/extension-jira": source("extension-jira"),
      "@roboplane/extension-opencode": source("extension-opencode"),
      "@roboplane/extension-pi": source("extension-pi"),
      "@roboplane/extension-scheduler": source("extension-scheduler"),
      "@roboplane/extension-scratch": source("extension-scratch"),
      "@roboplane/extension-steps": source("extension-steps"),
      "@roboplane/extension-webhooks": source("extension-webhooks"),
      "@roboplane/extension-worktree": source("extension-worktree"),
    },
  },
});
