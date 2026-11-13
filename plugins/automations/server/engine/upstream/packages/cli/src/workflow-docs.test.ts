import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");
const reference = fs.readFileSync(path.join(root, "docs", "workflow-authoring.md"), "utf8");
const configuration = fs.readFileSync(path.join(root, "docs", "configuration.md"), "utf8");
const agents = fs.readFileSync(path.join(root, "docs", "agents.md"), "utf8");
const safeActions = fs.readFileSync(path.join(root, "docs", "safe-actions.md"), "utf8");
const commands = fs.readFileSync(path.join(root, "docs", "commands.md"), "utf8");
const extensionAuthoring = fs.readFileSync(path.join(root, "docs", "extension-authoring.md"), "utf8");
const github = fs.readFileSync(path.join(root, "docs", "github.md"), "utf8");
const maintainer = fs.readFileSync(path.join(root, "docs", "maintainer.md"), "utf8");
const workspaces = fs.readFileSync(path.join(root, "docs", "workspaces.md"), "utf8");
const architecture = fs.readFileSync(path.join(root, "docs", "architecture.md"), "utf8");
const dependabot = fs.readFileSync(path.join(root, "examples", "maintainer", "11-dependabot-merge.md"), "utf8");
const maintainerExamples = fs.readFileSync(path.join(root, "examples", "maintainer", "README.txt"), "utf8");

describe("workflow authoring documentation", () => {
  it("covers every strict frontmatter key and first-party trigger", () => {
    for (const key of ["name", "disabled", "repository", "workspace", "agent", "model", "thinking", "on", "safeActions"]) expect(reference).toContain(`\`${key}\``);
    for (const type of [
      "schedule", "github.issue", "github.pull-request", "github.issue.comment",
      "github.pr.review", "github.pr.comment", "github.check",
    ]) expect(reference).toContain(`\`${type}\``);
  });

  it("covers every GitHub condition predicate and advanced string operation", () => {
    for (const predicate of [
      "labels", "author", "actor", "pull-request-author", "reply-to", "reviewer", "mentioned",
      "title", "body", "state", "author-association", "head-branch", "base-branch",
      "head-repository", "base-repository", "review-state", "check-conclusion", "draft", "merged",
      "event-label", "fork", "branch-relation", "number", "changed-files", "pull-request",
    ]) expect(reference).toContain(`\`${predicate}\``);
    for (const operation of [
      "equals", "not-equals", "one-of", "not-one-of", "starts-with", "ends-with",
      "contains", "matches", "not-matches", "exists", "case-sensitive",
    ]) expect(reference).toContain(`\`${operation}\``);
    for (const operation of ["any", "all", "none", "not", "gt", "gte", "lt", "lte"]) expect(reference).toContain(`\`${operation}\``);
  });

  it("documents the operational facts agents must account for", () => {
    for (const statement of [
      "Never create Mixer Automations workflow files inside a managed repository",
      "Multiple event types in one workflow are OR alternatives",
      "Manual execution does not require a `manual` trigger",
      "Polling is the default when no webhook is configured",
      "does not terminate an already running harness",
      "The workflow matcher is run a second time after activation",
      "direct `gh pr merge` commands are denied",
      "mixer-automations automations validate",
      "mixer-automations automations files",
      "Defaults to `worktree` when `repository` exists and `scratch` otherwise",
    ]) expect(reference).toContain(statement);
  });

  it("documents opt-in approval and merge policies and the serialized request", () => {
    for (const statement of [
      "github.pr.approve",
      "github.pr.merge",
      "allowedAuthors: [\"dependabot[bot]\"]",
      "head SHA",
      "minimumChecks",
      "mode: auto",
      "MIXER_AUTOMATIONS_RESULT",
      "Normal `gh pr merge` remains blocked",
    ]) expect(safeActions).toContain(statement);
  });

  it("documents one-run PR repair, babysitting, and merge authority", () => {
    for (const statement of [
      "github.pullRequests",
      "branchUpdates",
      'allowedAuthors: ["dependabot[bot]"]',
      "guarded fast-forward repairs",
      "without starting a second run",
    ]) expect(reference).toContain(statement);
    for (const statement of [
      "same run's confirmed guarded publication chain",
      "complete caretaker lifecycle in one run",
      "External advancement",
    ]) expect(safeActions).toContain(statement);
    for (const statement of [
      "A -> B -> C",
      "does not need a second run",
      "Auto mode performs another live-head check",
    ]) expect(github).toContain(statement);
  });

  it("keeps architecture, workspace, and maintainer guidance aligned", () => {
    expect(architecture).toContain("latest confirmed same-run head");
    expect(workspaces).toContain("Each confirmed successor head is recorded");
    expect(maintainer).toContain("validate, approve, and merge its final confirmed head without a second activation");
  });

  it("ships a true one-run Dependabot caretaker example", () => {
    for (const statement of [
      "github.pullRequests:",
      "github.pull-request:",
      "github.issue.comment:",
      "schedule:",
      "mode: immediate",
      "Babysit that current head",
      "no second run is required",
    ]) expect(dependabot).toContain(statement);
    expect(maintainerExamples).toContain("one-run dependency caretaker");
    expect(maintainerExamples).toContain("works with polling or webhooks");
  });
});

describe("installed CLI configuration documentation", () => {
  it("documents the generated config and both GitHub authentication paths", () => {
    for (const statement of [
      '"concurrency": 1',
      '"token": "${GITHUB_TOKEN}"',
      '"token": "github_pat_..."',
      "gh auth token",
      "does not read a private `.env` file",
      "There is no top-level `agents` configuration",
      "extensions.github.writerToken",
      "extensions.github.failureReports.enabled",
      '"retention": "24h"',
      "single lifetime for terminal run records and their per-run log files",
    ]) expect(configuration).toContain(statement);
  });

  it("documents thinking translation and installed CLI authentication", () => {
    for (const statement of [
      "thinking: high",
      "model_reasoning_effort=<thinking>",
      "installed CLI's normal home-directory credentials",
      "integration secrets are not inherited automatically",
    ]) expect(agents).toContain(statement);
  });
});

describe("CLI command documentation", () => {
  it("ships a self-contained personal extension authoring path", () => {
    for (const statement of [
      "mixer-automations docs --path", "mixer-automations docs --search", "mixer-automations extensions create",
      "mixer-automations extensions validate", "mixer-automations extensions reload", "api.workflows.registerField",
      "enabled by default", "api.config.get()", "workflow.extensions",
    ]) expect(extensionAuthoring).toContain(statement);
  });

  it("distinguishes reroute from manual run and replay", () => {
    for (const statement of [
      "mixer-automations events reroute <event>",
      "preserves its original type, source, actor, repository, and payload",
      "Do not substitute `mixer-automations automations run --input`",
      "duplicate_reroute",
    ]) expect(commands).toContain(statement);
  });

  it("documents the compact default run listing and retained-history options", () => {
    for (const statement of [
      "previous 24 hours",
      "places active runs last",
      "mixer-automations automations list --all",
      "--since 6h",
      "--limit 100",
      "history.retention",
    ]) expect(commands).toContain(statement);
  });
});
