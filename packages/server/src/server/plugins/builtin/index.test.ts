import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { compilePlugin } from "../compiler.js";
import { readPluginManifest } from "../manifest.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createTestMixerDaemon } from "../../test-utils/mixer-daemon.js";
import { BuiltinPluginLoader, builtinPlugins, resolveBuiltinPluginsRoot } from "./index.js";
import { randomUUID } from "node:crypto";
import { resultSchema } from "../../../../../../plugins/search/shared/search.js";

import { checkoutRepository } from "../../../../../../plugins/automations/server/checkout.js";
import { createWorkflowStore } from "../../../../../../plugins/automations/server/workflows.js";
import { createEngineRuntime } from "../../../../../../plugins/automations/server/engine-runtime.js";
import { initialAutomationConfiguration } from "../../../../../../plugins/automations/shared/configuration-template.js";
import { automationAuthoringContext } from "../../../../../../plugins/automations/server/authoring-context.js";
import { z } from "zod";
import { importRoboPlane } from "../../../../../../plugins/automations/server/import.js";
import {
  inspectRunResult,
  inspectRunLogs,
  readRunResult,
  runOverviewSummary,
  runStatusTone,
} from "../../../../../../plugins/automations/shared/run-inspection.js";
import {
  automationSettings,
  runSchema,
  safeActionSchema,
} from "../../../../../../plugins/automations/shared/contracts.js";
import {
  automationAgentEnvironment,
  createAutomationConfiguration,
  parseAutomationConfiguration,
} from "../../../../../../plugins/automations/server/configuration.js";
import {
  activateJiraIssue,
  JiraClient,
} from "../../../../../../plugins/automations/server/jira.js";

import { pollGithubRepository } from "../../../../../../plugins/automations/server/github-poll.js";
import {
  nextJiraOccurrence,
  parseDefinition,
} from "../../../../../../plugins/automations/server/definition.js";
import { executeSteps } from "../../../../../../plugins/automations/server/steps.js";
import { connectionSchema } from "../../../../../../plugins/automations/server/jira.js";

import { githubFacts } from "../../../../../../plugins/automations/server/github-facts.js";
import { matchesGitHubTrigger } from "../../../../../../plugins/automations/server/github-matcher.js";
import { enrichGithubCheck } from "../../../../../../plugins/automations/server/github-enrichment.js";
import {
  executeAction,
  prepareAction,
  validateAction,
  reconcileAction,
} from "../../../../../../plugins/automations/server/safe-actions.js";

const roots: string[] = [];

test("Automations Ask AI receives installed extension authoring resources and isolated validation instructions", async () => {
  const home = path.join(os.tmpdir(), "mixer authoring host");
  const context = automationAuthoringContext(home);
  const match = context.match(/\{\n[\s\S]*?\n\}/);
  expect(match).not.toBeNull();
  const resources = z
    .object({ docs: z.string(), sdk: z.string(), cli: z.string() })
    .parse(JSON.parse(match?.[0] ?? "null"));
  expect(context).toContain(JSON.stringify(path.join(home, ".mixer-automations", "extensions")));
  expect(context).toContain(JSON.stringify(path.join(home, "automations", "config.json")));
  expect(context).toContain(JSON.stringify(resources.docs));
  expect(context).toContain(JSON.stringify(resources.sdk));
  expect(context).toContain(JSON.stringify([resources.cli, "--home", "<test-home>"]));
  expect(context).toContain("ELECTRON_RUN_AS_NODE=1");
  expect(context).toContain("@mixer/automations-sdk");
  expect(context).toContain("MIXER_AUTOMATIONS_RESULT");
  expect(context).toContain("The workflow helper is mixer-automations, not the host mixer CLI.");
  expect(context).toContain("Ask before installing code into the live extensions directory");
  expect(context).toContain("${NAME}");
  expect(await readFile(path.join(resources.docs, "extension-authoring.md"), "utf8")).toContain(
    "api.workflows.registerField",
  );
  expect(await readFile(path.join(resources.sdk, "dist", "index.d.ts"), "utf8")).toContain(
    "defineExtension",
  );
});

test("Automations status colors distinguish running, interrupted, and cancelled runs", () => {
  expect(runStatusTone({ status: "running" })).toBe("warning");
  expect(runStatusTone({ status: "interrupted" })).toBe("danger");
  expect(runStatusTone({ status: "interrupted", sourceStatus: "cancelled" })).toBe("danger");
  expect(runStatusTone({ status: "failed" })).toBe("danger");
  expect(runStatusTone({ status: "attention" })).toBe("danger");
  expect(runStatusTone({ status: "succeeded" })).toBe("success");
  expect(runStatusTone({ status: "queued" })).toBe("muted");
});

async function automationTestHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-engine-host-"));
  roots.push(root);
  await mkdir(path.join(root, ".mixer", "automations"), { recursive: true });
  await writeFile(
    path.join(root, ".mixer", "automations", "config.json"),
    JSON.stringify({
      runtime: { shutdownTimeout: 100 },
      extensions: {
        scheduler: {},
        github: { enabled: false },
        jira: { enabled: false },
        webhooks: { enabled: false },
      },
    }),
  );
  return root;
}

test("Automations lets users save generic credential templates and choose Ask AI before integrations are configured", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-config-draft-"));
  roots.push(home);
  vi.stubEnv("JIRA_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  const runtime = createEngineRuntime(home);
  try {
    expect(await runtime.status()).toMatchObject({
      paused: true,
      errors: [
        {
          source: "engine",
          message: expect.stringContaining("Missing environment variable JIRA_TOKEN"),
        },
      ],
    });
    expect(await runtime.configurationInfo("mock")).toMatchObject({ agentProvider: "mock" });
    const store = createWorkflowStore(home, runtime.validation);
    const source = await store.read("config.json");
    const saved = await store.save({ ...source, content: initialAutomationConfiguration });
    expect(saved.content).toContain('"token": "${JIRA_TOKEN}"');
    expect(saved.content).toContain('"token": "${GITHUB_TOKEN}"');
    expect(JSON.parse(saved.content).history.retention).toBe("1d");
    expect(saved.content).not.toContain("ITX_");
    expect(saved.content).not.toContain("inditex");
    expect(await runtime.list()).toEqual({ runs: [] });
    await expect(runtime.start("any.md")).rejects.toThrow(
      "Missing environment variable JIRA_TOKEN",
    );
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
  }
});

test("Automations result inspection uses the namespaced marker without legacy aliases", () => {
  const run = runSchema.parse({
    id: "00000000-0000-4000-8000-000000000004",
    path: "report.md",
    name: "Report",
    trigger: "manual",
    status: "succeeded",
    createdAt: 1,
    output: 'Progress\nMIXER_AUTOMATIONS_RESULT: {"reason":"Verified"}',
  });
  expect(inspectRunResult(run)).toEqual({ reason: "Verified" });
  expect(
    inspectRunResult({ ...run, output: 'ROBOPLANE_RESULT: {"reason":"Old"}' }),
  ).toBeUndefined();
  expect(
    inspectRunResult({ ...run, output: 'MIXER_RESULT: {"reason":"Ambiguous"}' }),
  ).toBeUndefined();
});

test("Automations overview shows status instead of logs until a run has finished", () => {
  const run = runSchema.parse({
    id: "00000000-0000-4000-8000-000000000003",
    path: "monitor.md",
    name: "Monitor",
    trigger: "manual",
    status: "running",
    createdAt: 1,
    output: '{"level":30,"msg":"live log"}',
    engine: { event: {}, steps: [], actions: [], verification: [] },
  });
  expect(runOverviewSummary(run)).toBe("This workflow is running");
  expect(runOverviewSummary({ ...run, status: "queued" })).toBe("This workflow is queued");
  expect(runOverviewSummary({ ...run, status: "succeeded" })).toBe("No result recorded.");
  expect(
    runOverviewSummary({ ...run, status: "succeeded", result: { reason: "No defects found." } }),
  ).toBe("No defects found.");
});

test("Mixer Automations runs the vendored engine with bundled CLI handoffs, replay, and workspace cleanup", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-embedded-engine-"));
  roots.push(home);
  const workflows = path.join(home, "automations");
  await mkdir(workflows);
  await mkdir(path.join(home, ".mixer-automations", "extensions"), { recursive: true });
  await writeFile(
    path.join(home, ".mixer-automations", "extensions", "fixture.ts"),
    'import { defineExtension, z } from "@mixer/automations-sdk";\nexport default defineExtension({ name: "fixture", setup(api) { api.workflows.registerField("fixture.label", { schema: z.string() }); } });\n',
  );
  await writeFile(
    path.join(workflows, "config.json"),
    JSON.stringify({
      runtime: { shutdownTimeout: 100 },
      extensions: {
        github: { enabled: false },
        jira: { enabled: false },
        scheduler: { enabled: false },
        webhooks: { enabled: false },
      },
    }),
  );
  await writeFile(
    path.join(workflows, "child.yaml"),
    "name: Child\non: {}\nsteps:\n  - run: echo BUNDLED_CHILD_OK\n",
  );
  await writeFile(
    path.join(workflows, "parent.yaml"),
    "name: Parent\non: {}\nfixture.label: Embedded extension\nsteps:\n  - run: mixer-automations automations run child.yaml --json --handoff-key child\n",
  );
  const engine = createEngineRuntime(home);
  try {
    expect((await engine.status()).errors).toEqual([]);
    const parent = await engine.start("parent.yaml");
    await expect
      .poll(async () => (await engine.get(parent.id)).status, { timeout: 15_000 })
      .toBe("succeeded");
    await expect
      .poll(
        async () => (await engine.list()).runs.find((run) => run.path === "child.yaml")?.status,
        { timeout: 15_000 },
      )
      .toBe("succeeded");
    const child = (await engine.list()).runs.find((run) => run.path === "child.yaml");
    if (!child) throw new Error("The bundled CLI did not create its child run.");
    expect((await engine.get(child.id)).output).toContain("BUNDLED_CHILD_OK");
    expect((await engine.get(child.id)).engine?.steps).toHaveLength(1);
    expect(await readdir(path.join(home, ".mixer-automations", "workspaces"))).toEqual([]);
    const replay = await engine.replay(child.id, "snapshot");
    await expect
      .poll(async () => (await engine.get(replay.id)).status, { timeout: 15_000 })
      .toBe("succeeded");
    expect((await engine.get(replay.id)).engine?.event).toMatchObject({
      provenance: { kind: "replay", sourceRunId: child.id },
    });
    const store = createWorkflowStore(home, engine.validation);
    expect((await store.describe()).workflows.map((workflow) => workflow.path)).toEqual([
      "child.yaml",
      "parent.yaml",
    ]);
  } finally {
    await engine.close();
  }
});

test("Mixer Automations requires explicit activation when replacing native execution", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-engine-review-"));
  roots.push(home);
  await mkdir(path.join(home, "automation-state"));
  await mkdir(path.join(home, "automations"));
  await writeFile(
    path.join(home, "automations", "config.json"),
    JSON.stringify({
      runtime: { shutdownTimeout: 100 },
      extensions: {
        github: { enabled: false },
        jira: { enabled: false },
        scheduler: { enabled: false },
        webhooks: { enabled: false },
      },
    }),
  );
  await writeFile(
    path.join(home, "automations", "review.yaml"),
    "on: {}\nsteps:\n  - run: echo REVIEWED_ENGINE_OK\n",
  );
  await writeFile(
    path.join(home, "automations", "scheduled.md"),
    "---\non:\n  schedule:\n    cron: '0 9 * * *'\n---\n\nRead the dashboard.\n",
  );
  const runtime = createEngineRuntime(home);
  try {
    expect(await runtime.status()).toMatchObject({
      paused: true,
      errors: [],
      notices: [{ source: "migration", message: "Review configuration, then Start Automations." }],
    });
    const store = createWorkflowStore(home, runtime.validation);
    const listing = await store.describe();
    expect(listing.workflows.find((workflow) => workflow.path === "scheduled.md")?.error).toBe(
      "Scheduling is disabled. Enable extensions.scheduler.enabled in config.json, then restart Automations.",
    );
    expect(
      JSON.parse(await readFile(path.join(home, "automations", "config.json"), "utf8")).extensions
        .scheduler.enabled,
    ).toBe(false);
    await expect(runtime.start("review.yaml")).rejects.toThrow("Start Mixer Automations");
    expect(await runtime.control("start")).toMatchObject({
      paused: false,
      errors: [],
      notices: [],
    });
    const run = await runtime.start("review.yaml");
    await expect.poll(async () => (await runtime.get(run.id)).status).toBe("succeeded");
    expect(
      JSON.parse(
        await readFile(path.join(home, ".mixer-automations", "engine-started.json"), "utf8"),
      ),
    ).toMatchObject({ version: 1 });
  } finally {
    await runtime.close();
  }
});

test("Automations creates configuration with scheduling enabled and never overwrites an existing configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-default-scheduler-"));
  roots.push(home);
  const store = createWorkflowStore(home);
  await store.create("config.json");
  const file = path.join(home, "automations", "config.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    extensions: {
      scheduler: {},
      worktree: {},
      github: {
        token: "${GITHUB_TOKEN}",
        pollInterval: "5m",
        publishGuard: { enabled: true, maxChangedFiles: null },
        failureReports: { enabled: false },
      },
      jira: { baseUrl: "https://jira.example.com", token: "${JIRA_TOKEN}" },
      opencode: { env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", JIRA_TOKEN: "${JIRA_TOKEN}" } },
    },
  });
  const existing = '{"extensions":{"scheduler":{"enabled":false}}}\n';
  await writeFile(file, existing);
  await expect(store.create("config.json")).rejects.toThrow("already exists");
  expect(await readFile(file, "utf8")).toBe(existing);
});

test("Automations inspection separates structured results and notes from recorded logs", () => {
  const run = runSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    path: "monitor.md",
    name: "Monitor",
    trigger: "manual",
    status: "succeeded",
    createdAt: 1,
    output:
      'Progress\nMIXER_AUTOMATIONS_RESULT: {"version":1,"outcome":"no-op","reason":"No defects found.","verification":["Read the dashboard"],"unresolved":["Missing source maps"]}',
  });
  expect(inspectRunResult(run)).toEqual({
    outcome: "no-op",
    reason: "No defects found.",
    verification: ["Read the dashboard"],
    unresolved: ["Missing source maps"],
  });
  expect(readRunResult('{"level":30,"msg":"ordinary log"}')).toBeUndefined();
  expect(readRunResult("broken json")).toBeUndefined();
  expect(inspectRunLogs('{"level":30,"msg":"started"}\n{"level":40,"msg":"warning"}\n')).toEqual({
    language: "json",
    content:
      '[\n  {\n    "level": 30,\n    "msg": "started"\n  },\n  {\n    "level": 40,\n    "msg": "warning"\n  }\n]',
  });
  expect(inspectRunLogs("plain output\n{bad json\n")).toEqual({
    language: "text",
    content: "plain output\n{bad json\n",
  });
});

test("Automations imports RoboPlane result reasons, notes, and unresolved items without replacing log output", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-run-inspection-"));
  roots.push(home);
  await mkdir(path.join(home, "state"));
  await mkdir(path.join(home, "logs"));
  await mkdir(path.join(home, "automations"));
  const destination = path.join(home, "native");
  await mkdir(destination);
  const db = new DatabaseSync(path.join(home, "state", "roboplane.db"));
  const result = {
    outcome: "no-op",
    reason: "No confirmed defects.",
    verification: ["Checked logs"],
    unresolved: ["Missing source maps"],
  };
  try {
    db.exec(
      "CREATE TABLE runs(id TEXT, workflow_id TEXT, repository TEXT, status TEXT, error TEXT, created_at TEXT, updated_at TEXT, outcome_json TEXT)",
    );
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "rp_inspection",
      "monitor.md",
      "org/repo",
      "completed",
      null,
      "2026-11-12T09:15:00Z",
      "2026-11-12T09:19:00Z",
      JSON.stringify(result),
    );
  } finally {
    db.close();
  }
  await writeFile(
    path.join(home, "logs", "rp_inspection.log"),
    '{"level":30,"msg":"workspace attested"}\n',
  );
  const imported: (typeof runSchema)["_output"][] = [];
  const counts = await importRoboPlane(
    home,
    destination,
    async (run) => {
      imported.push(run);
      return true;
    },
    () => "00000000-0000-4000-8000-000000000002",
  );
  expect(counts).toEqual({ workflows: 0, runs: 1, skipped: 0 });
  expect(imported).toHaveLength(1);
  expect(imported[0].result).toEqual(result);
  expect(imported[0].output).toBe('{"level":30,"msg":"workspace attested"}\n');
});

test("Automations passes config environment values as data with workflow and step precedence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mixer-automation-environment-"));
  roots.push(directory);
  const config = parseDefinition(
    "values.yaml",
    [
      "env: {WORKFLOW_VALUE: workflow, STEP_VALUE: workflow}",
      "steps:",
      "  - env: {STEP_VALUE: step}",
      '    run: printf "%s/%s/%s/%s" "$GLOBAL_VALUE" "$WORKFLOW_VALUE" "$STEP_VALUE" "$MIXER_RUN_ID"',
    ].join("\n"),
  );
  if (config.kind !== "steps") throw new Error("Expected a scripted workflow");
  let output = "";
  await executeSteps(
    config,
    await realpath(directory),
    new AbortController().signal,
    (chunk) => {
      output += chunk;
    },
    { MIXER_RUN_ID: "context" },
    { GLOBAL_VALUE: "global", WORKFLOW_VALUE: "global", STEP_VALUE: "global" },
  );
  expect(output).toBe("\nstep_1 · Attempt 1\nglobal/workflow/step/context");
});

test("Automations config.json resolves environment references, rejects unsupported fields, and masks integration secrets", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-automation-config-"));
  roots.push(home);
  const store = createWorkflowStore(home);
  await store.create("config.json");
  vi.stubEnv("MIXER_CONFIG_GITHUB", "fixture-github-secret");
  vi.stubEnv("MIXER_CONFIG_ALIAS", "fixture-github-secret");
  vi.stubEnv("MIXER_CONFIG_TEAM", "workflow-team");
  const content = JSON.stringify({
    runtime: { concurrency: 2, maxQueuedRuns: 7, timeout: 5000, noOutputTimeout: 1_200_000 },
    history: { retention: "24h" },
    extensions: {
      github: {
        token: "${MIXER_CONFIG_GITHUB}",
        polling: false,
        apiUrl: "https://forge.example.invalid/api/v3",
        failureReports: { enabled: false },
      },
      scheduler: { enabled: false },
      mixer: { agentProvider: "codex" },
      codex: { env: { TEAM: "${MIXER_CONFIG_TEAM}" } },
      steps: { env: { TEAM: "${MIXER_CONFIG_TEAM}" } },
    },
  });
  await store.save({ ...(await store.read("config.json")), content });
  const settings = createAutomationConfiguration(home, {
    read: async () => ({
      status: "ready",
      revision: "fixture",
      values: automationSettings.schema.parse({}),
    }),
    subscribe: () => () => {},
  });
  const state = await settings.read();
  expect(state.status).toBe("ready");
  if (state.status !== "ready") throw new Error(state.error);
  expect(state.values.credentials.githubToken).toBe("fixture-github-secret");
  expect(state.values.credentials.githubActionToken).toBe("fixture-github-secret");
  expect(state.values.retentionMs).toBe(86_400_000);
  expect(state.values.runtime.maxQueuedRuns).toBe(7);
  expect(state.values.runtime.concurrency).toBe(2);
  expect(state.values.runtime.noOutputTimeout).toBe(1_200_000);
  expect(state.values.worktree.cloneBaseUrl).toBe("https://forge.example.invalid");
  expect(state.values.steps.env).toEqual({ TEAM: "workflow-team" });
  expect(automationAgentEnvironment(state.values, "codex/default")).toEqual({
    MIXER_CONFIG_GITHUB: "",
    MIXER_CONFIG_ALIAS: "",
    TEAM: "workflow-team",
  });
  expect((await store.describe()).configuration).toBe(true);
  expect((await store.describe()).workflows).toEqual([]);
  expect(() =>
    parseAutomationConfiguration('{"extensions":{"github":{"token":"${MISSING_TOKEN}"}}}', {}),
  ).toThrow("Missing environment variable MISSING_TOKEN at config.extensions.github.token");
  expect(() => parseAutomationConfiguration('{"runtime":{"concurrency":33}}')).toThrow(
    "config.runtime.concurrency",
  );
  expect(() =>
    parseAutomationConfiguration('{"extensions":{"steps":{"env":{"PATH":"unsafe"}}}}'),
  ).toThrow("reserved");
  expect(() =>
    parseAutomationConfiguration('{"extensions":{"github":{"publishGuard":{}}}}'),
  ).toThrow("publishGuard");
  expect(() =>
    parseAutomationConfiguration('{"extensions":{"github":{"failureReports":{"enabled":true}}}}'),
  ).toThrow("failureReports.enabled");
  await writeFile(
    path.join(home, "automations", "config.json"),
    '{"token":"do-not-log-this-secret",',
  );
  await expect(settings.read()).resolves.toEqual({
    status: "error",
    error: "Invalid JSON in automations/config.json. Correct its syntax.",
  });
});

test("Automations activates Jira issues with current JQL and fields, and skips changed or ineligible versions", async () => {
  let updated = "2026-01-01T00:00:00Z";
  let eligible = true;
  const queries: unknown[] = [];
  const jira = await localListener(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    queries.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        startAt: 0,
        maxResults: 2,
        total: eligible ? 1 : 0,
        issues: eligible
          ? [
              {
                id: "12",
                key: "MIX-12",
                fields: { summary: "Current summary", updated, description: "Current description" },
              },
            ]
          : [],
      }),
    );
  });
  try {
    const client = new JiraClient(
      connectionSchema.parse({ baseUrl: jira.url, token: "fixture-token" }),
    );
    const trigger = {
      cron: "* * * * *",
      jql: "project = MIX",
      fields: ["description"],
      timezone: "UTC",
    };
    const event = {
      source: "jira" as const,
      id: "issue-version",
      payload: { issue: { id: "12", key: "MIX-12", fields: { summary: "Old summary", updated } } },
    };
    await expect(
      activateJiraIssue(client, trigger, event, new AbortController().signal),
    ).resolves.toMatchObject({
      payload: {
        issue: { fields: { summary: "Current summary", description: "Current description" } },
      },
    });
    expect(queries[0]).toMatchObject({
      jql: "(project = MIX) AND id = 12",
      fields: ["summary", "updated", "description"],
      maxResults: 2,
    });
    updated = "2026-01-02T00:00:00Z";
    await expect(
      activateJiraIssue(client, trigger, event, new AbortController().signal),
    ).resolves.toBeNull();
    eligible = false;
    await expect(
      activateJiraIssue(client, trigger, event, new AbortController().signal),
    ).resolves.toBeNull();
    const observed = queries.length;
    await expect(
      activateJiraIssue(
        client,
        trigger,
        { ...event, authority: "https://different.example.invalid" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("authority changed");
    expect(queries.length).toBe(observed);
  } finally {
    await jira.close();
  }
});

test("Automations creates nested workflows by file extension without overwriting files or following folder symlinks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-workflow-files-"));
  roots.push(home);
  const store = createWorkflowStore(home);
  await store.create("shared/issues/triage.md");
  await store.create("shared/checks/build.yml");
  await store.createDirectory("empty");
  expect((await store.describe()).directories).toEqual([
    "empty",
    "shared",
    "shared/checks",
    "shared/issues",
  ]);
  await expect(store.createDirectory("empty")).rejects.toThrow("already exists");
  await expect(store.createDirectory("../outside")).rejects.toThrow();
  await expect(store.createDirectory("CONFIG.JSON /child")).rejects.toThrow("reserved");
  await expect(store.create("config.json /child.yaml")).rejects.toThrow();
  expect(await store.hasConfiguration()).toBe(false);
  expect((await store.describe()).workflows).toMatchObject([
    { path: "shared/checks/build.yml", kind: "steps", disabled: true },
    { path: "shared/issues/triage.md", kind: "agent", disabled: true },
  ]);
  await expect(store.create("shared/checks/build.yml")).rejects.toThrow("already exists");
  await expect(store.create("../outside.yaml")).rejects.toThrow();
  await expect(store.create("shared/not-a-workflow.txt")).rejects.toThrow();
  await mkdir(path.join(home, "outside"));
  await symlink(path.join(home, "outside"), path.join(home, "automations", "linked"), "dir");
  await expect(store.create("linked/run.yaml")).rejects.toThrow("symbolic links");
  await expect(store.createDirectory("linked/child")).rejects.toThrow("symbolic links");
  expect(await stat(path.join(home, "outside", "run.yaml")).catch(() => null)).toBeNull();
});

test("Automations moves workflows between folders and root without replacing files or following symlinks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-workflow-move-"));
  roots.push(home);
  const store = createWorkflowStore(home);
  await store.create("task.yaml");
  await store.createDirectory("nested");
  const original = await store.read("task.yaml");
  const moved = await store.move({ ...original, destination: "nested/task.yaml" });
  expect(moved).toEqual({ ...original, path: "nested/task.yaml" });
  await expect(store.read("task.yaml")).rejects.toThrow();
  expect(await store.move({ ...moved, destination: "task.yaml" })).toEqual(original);
  await store.create("nested/task.yaml");
  const collision = await store.read("nested/task.yaml");
  await expect(store.move({ ...original, destination: "nested/task.yaml" })).rejects.toThrow(
    "already exists",
  );
  expect(await store.read("nested/task.yaml")).toEqual(collision);
  expect(await store.read("task.yaml")).toEqual(original);
  const updated = await store.save({ ...original, content: "steps:\n  - run: echo changed\n" });
  await expect(store.move({ ...original, destination: "nested/new.yaml" })).rejects.toThrow(
    "changed on disk",
  );
  await expect(store.move({ ...updated, destination: "../outside.yaml" })).rejects.toThrow();
  await expect(store.move({ ...updated, destination: "config.json/child.yaml" })).rejects.toThrow();
  await mkdir(path.join(home, "outside"));
  await symlink(path.join(home, "outside"), path.join(home, "automations", "linked"), "dir");
  await expect(store.move({ ...updated, destination: "linked/task.yaml" })).rejects.toThrow(
    "symbolic links",
  );
  expect(await store.read("task.yaml")).toEqual(updated);
  expect(await stat(path.join(home, "outside", "task.yaml")).catch(() => null)).toBeNull();
  await store.create("config.json");
  const configuration = await store.read("config.json");
  await expect(
    store.move({ ...configuration, destination: "nested/config.yaml" }),
  ).rejects.toThrow();
  expect(await store.read("config.json")).toEqual(configuration);
});

test("Automations manages workflow drafts, rejects stale saves and deletes, and validates before enabling", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-workflow-management-"));
  roots.push(home);
  const store = createWorkflowStore(home);
  await store.create("review.md");
  const draft = await store.read("review.md");
  expect(draft.content).toContain("disabled: true");
  const content = "---\nname: Review\ndisabled: true\non: {}\n---\n\nReview the current project.\n";
  const saved = await store.save({ ...draft, content });
  expect(saved.content).toBe(content);
  expect(await store.read("review.md")).toEqual(saved);
  await expect(store.save({ ...draft, content: "Overwrite a newer edit." })).rejects.toThrow(
    "changed on disk",
  );
  await expect(store.remove(draft)).rejects.toThrow("changed on disk");
  const enabled = await store.setEnabled({ ...saved, enabled: true });
  expect((await store.describe()).workflows).toMatchObject([
    { path: "review.md", disabled: false },
  ]);
  expect(enabled.content).toContain("Review the current project.");
  const disabled = await store.setEnabled({ ...enabled, enabled: false });
  await writeFile(path.join(home, "automations", "broken.yaml"), "disabled: true\nsteps: broken\n");
  const broken = await store.read("broken.yaml");
  await expect(store.setEnabled({ ...broken, enabled: true })).rejects.toThrow();
  expect((await store.read("broken.yaml")).content).toBe("disabled: true\nsteps: broken\n");
  await expect(
    store.save({ ...disabled, content: "---\nunsupported: true\n---\nPrompt" }),
  ).rejects.toThrow();
  expect(await store.read("review.md")).toEqual(disabled);
  await store.remove(disabled);
  await expect(store.read("review.md")).rejects.toThrow();
});

test("Automations serializes conflicting editor saves and keeps workflow bodies intact", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mixer-workflow-edits-"));
  roots.push(home);
  const store = createWorkflowStore(home);
  await store.create("build.yaml");
  const source = await store.read("build.yaml");
  const content = "# Keep this comment\nname: Build\ndisabled: true\nsteps:\n  - run: echo built\n";
  const results = await Promise.allSettled([
    store.save({ ...source, content }),
    store.save({ ...source, content: "steps:\n  - run: echo overwritten\n" }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  const saved = await store.read("build.yaml");
  const enabled = await store.setEnabled({ ...saved, enabled: true });
  expect(enabled.content).toContain("# Keep this comment");
  expect(enabled.content).toContain("echo built");
  expect((await store.describe()).workflows).toMatchObject([
    { path: "build.yaml", disabled: false },
  ]);
});

test("Automations reports invalid Jira URLs as validation failures without throwing", () => {
  for (const baseUrl of [
    "",
    "not-a-url",
    "http://jira.example.com",
    "https://user:password@jira.example.com",
  ]) {
    expect(connectionSchema.safeParse({ baseUrl, token: "test-token" }).success).toBe(false);
  }
  expect(
    connectionSchema.parse({ baseUrl: "https://jira.example.com/jira/", token: "test-token" })
      .baseUrl,
  ).toBe("https://jira.example.com/jira");
});

test("every bundled plugin starts on the current Mixer release", async () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../../../../../../package.json", import.meta.url), "utf8"),
  );
  const daemon = await createTestMixerDaemon({
    mixerHomeRoot: await automationTestHome(),
    daemonVersion: version,
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot()),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: version });
  try {
    await client.connect();
    expect((await client.getPluginCatalog()).map(({ id }) => id).sort()).toEqual(
      [...builtinPlugins].sort(),
    );
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("Automations starts with external plugins disabled and opens workflows from the owning host", async () => {
  vi.stubEnv("MIXER_TEST_UNSET_CONFIG_TOKEN", undefined);
  const daemon = await createTestMixerDaemon({
    mixerHomeRoot: await automationTestHome(),
    daemonVersion: "0.14.0-beta.1",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["automations"]),
    agentClients: createTestAgentClients(),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    expect((await client.getPluginCatalog()).map(({ id }) => id)).toEqual(["automations"]);
    await expect(
      client.invokePluginRpc("automations", "automations.runtime.status", {}),
    ).resolves.toMatchObject({
      paused: false,
      listening: false,
      pending: 0,
      schedulesEnabled: true,
      integrations: expect.arrayContaining([
        {
          name: "jira",
          ready: false,
          message: "Disabled in config.json.",
        },
        {
          name: "github",
          ready: false,
          message: "Disabled in config.json.",
        },
      ]),
      errors: [],
    });
    await expect(
      client.invokePluginRpc("automations", "automations.runtime.control", { action: "stop" }),
    ).resolves.toMatchObject({ paused: true, listening: false });
    const root = path.join(daemon.mixerHome, "automations");
    await expect.poll(async () => (await stat(root).catch(() => null))?.isDirectory()).toBe(true);
    expect(await client.invokePluginRpc("automations", "automations.workflows.list", {})).toEqual({
      workflows: [],
      limited: false,
      configuration: true,
      directories: [],
    });
    await expect(
      client.invokePluginRpc("automations", "automations.workflows.create", {
        path: "review.md",
      }),
    ).resolves.toEqual({ path: "review.md" });
    expect(readFileSync(path.join(root, "review.md"), "utf8")).toContain("disabled: true");
    const source = await client.invokePluginRpc("automations", "automations.workflows.read", {
      path: "review.md",
    });
    await expect(
      client.invokePluginRpc("automations", "automations.workflows.save", source),
    ).resolves.toEqual(source);
    await expect(
      client.invokePluginRpc("automations", "automations.workflows.open", {
        path: "review.md",
      }),
    ).resolves.toMatchObject({ path: "review.md", workspaceId: expect.any(String) });
    await expect(
      client.invokePluginRpc("automations", "automations.workflows.open", {
        path: "../review.md",
      }),
    ).rejects.toThrow();
    await expect(
      client.invokePluginRpc("automations", "automations.runs.start", { path: "review.md" }),
    ).rejects.toThrow();
    const script = "name: Smoke run\non: {}\nsteps:\n  - run: echo mixer-automation\n";
    await writeFile(path.join(root, "smoke.yaml"), script);
    await expect(
      client.invokePluginRpc("automations", "automations.runs.start", { path: "smoke.yaml" }),
    ).rejects.toThrow("Start Mixer Automations");
    await expect(
      client.invokePluginRpc("automations", "automations.runtime.control", { action: "start" }),
    ).resolves.toMatchObject({ paused: false });
    await expect(
      client.invokePluginRpc("automations", "automations.runtime.control", { action: "restart" }),
    ).resolves.toMatchObject({ paused: false });
    const { id } = (await client.invokePluginRpc("automations", "automations.runs.start", {
      path: "smoke.yaml",
    })) as { id: string };
    await expect
      .poll(() => client.invokePluginRpc("automations", "automations.runs.get", { id }))
      .toMatchObject({
        status: "succeeded",
        trigger: "manual",
        output: expect.stringContaining("mixer-automation"),
      });
    const settings = (await client.invokePluginRpc(
      "automations",
      "settings.preferences.read",
      {},
    )) as {
      revision: string;
    };
    const history = path.join(daemon.mixerHome, "automation-state", "runs");
    await mkdir(history, { recursive: true });
    const expired = randomUUID();
    const expiredPath = path.join(history, `${expired}.json`);
    const old = Date.now() - 2 * 86_400_000;
    await writeFile(
      expiredPath,
      JSON.stringify({
        id: expired,
        path: "smoke.yaml",
        name: "Expired",
        trigger: "manual",
        status: "succeeded",
        createdAt: old,
        finishedAt: old,
        output: "",
      }),
    );
    await expect(
      client.invokePluginRpc("automations", "settings.preferences.write", {
        revision: settings.revision,
        values: { agentProvider: "codex", retentionDays: 1, schedulesEnabled: true },
      }),
    ).resolves.toMatchObject({ status: "saved" });
    await expect(
      client.invokePluginRpc("automations", "automations.chat.prepare", {
        path: "review.md",
      }),
    ).resolves.toEqual({
      workspaceId: expect.any(String),
      cwd: await realpath(root),
      title: "Automation: review.md",
      systemPrompt: expect.stringContaining("review.md"),
    });
    expect((await stat(expiredPath)).isFile()).toBe(true);
    await expect
      .poll(() => client.invokePluginRpc("automations", "automations.runs.list", {}), {
        timeout: 12_000,
      })
      .toMatchObject({
        runs: expect.arrayContaining([expect.objectContaining({ id, status: "succeeded" })]),
      });
    await writeFile(
      path.join(root, "config.json"),
      '{"extensions":{"jira":{"enabled":false,"token":"${MIXER_TEST_UNSET_CONFIG_TOKEN}"}}}',
    );
    await expect(
      client.invokePluginRpc("automations", "automations.runtime.control", { action: "restart" }),
    ).rejects.toThrow("Missing environment variable MIXER_TEST_UNSET_CONFIG_TOKEN");
    const editingChat = await client.invokePluginRpc("automations", "automations.chat.prepare", {
      path: "smoke.yaml",
    });
    expect(editingChat).toMatchObject({
      title: "Automation: smoke.yaml",
      cwd: await realpath(root),
      workspaceId: expect.any(String),
    });
  } finally {
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
  }
}, 60_000);

async function localListener(handler?: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("Automations approval reconciliation requires the token identity's latest review on the unchanged exact revision", async () => {
  let reviewState = "APPROVED";
  let sha = reviewedSha;
  const methods: string[] = [];
  const github = await localListener((request, response) => {
    methods.push(request.method ?? "");
    let payload: unknown;
    if (request.url === "/user") payload = { login: "mixer-bot" };
    else if (request.url?.includes("/reviews?"))
      payload = [
        { state: "APPROVED", commit_id: reviewedSha, user: { login: "mixer-bot" } },
        { state: reviewState, commit_id: reviewedSha, user: { login: "mixer-bot" } },
      ];
    else payload = fixturePullRequest(sha);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  try {
    const action = safeActionSchema.parse({
      name: "github.pr.approve",
      apiUrl: github.url,
      status: "uncertain",
      repository: githubRepository,
      number: 32,
      sha: reviewedSha,
      branch: "dependabot/update",
      baseBranch: "develop",
      author: "dependabot[bot]",
    });
    await expect(
      reconcileAction(action, "fixture-token", new AbortController().signal, github.url),
    ).resolves.toBe(true);
    reviewState = "DISMISSED";
    await expect(
      reconcileAction(action, "fixture-token", new AbortController().signal, github.url),
    ).resolves.toBe(false);
    sha = "b".repeat(40);
    await expect(
      reconcileAction(action, "fixture-token", new AbortController().signal, github.url),
    ).resolves.toBe(false);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
    const observed = methods.length;
    await expect(
      reconcileAction(
        action,
        "fixture-token",
        new AbortController().signal,
        `${github.url}/different-api`,
      ),
    ).rejects.toThrow("authority changed");
    expect(methods.length).toBe(observed);
  } finally {
    await github.close();
  }
});

test("Automations GitHub polling baselines history and delivers new events in order", async () => {
  const issue = (id: string) => ({ id, type: "IssuesEvent", payload: { action: "opened" } });
  const dispatch = vi.fn().mockResolvedValue(1);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json([issue("10"), issue("9")]))
      .mockResolvedValueOnce(Response.json([issue("12"), issue("11"), issue("10")])),
  );
  const signal = new AbortController().signal;
  try {
    const cursor = await pollGithubRepository(
      "test-org/test-repo",
      "fixture",
      undefined,
      signal,
      dispatch,
    );
    expect(cursor).toBe("10");
    expect(dispatch).not.toHaveBeenCalled();
    await expect(
      pollGithubRepository("test-org/test-repo", "fixture", cursor, signal, dispatch),
    ).resolves.toBe("12");
    expect(dispatch.mock.calls.map(([event]) => event.id)).toEqual(["poll:11", "poll:12"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Automations GitHub polling fails closed rather than advancing past a truncated history", async () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    id: String(1000 - index),
    type: "IssuesEvent",
    payload: { action: "opened" },
  }));
  let delivered = 0;
  const github = await localListener((_request, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(events)),
  );
  try {
    await expect(
      pollGithubRepository(
        "fixture/repository",
        "fixture-token",
        "old-cursor",
        new AbortController().signal,
        async () => {
          delivered++;
          return 1;
        },
        { apiUrl: github.url, maxPages: 1 },
      ),
    ).rejects.toThrow("cursor has not advanced");
    expect(delivered).toBe(0);
  } finally {
    await github.close();
  }
});

const reviewedSha = "a".repeat(40);
const githubRepository = "fixture-org/fixture-repo";
function fixturePullRequest(sha = reviewedSha) {
  return {
    number: 32,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    user: { login: "dependabot[bot]" },
    title: "Bump dependencies",
    changed_files: 2,
    labels: [{ name: "dependencies" }],
    head: { sha, ref: "dependabot/update", repo: { full_name: githubRepository } },
    base: { ref: "develop", repo: { full_name: githubRepository } },
  };
}

test("Automations GitHub check filters combine exact-commit enrichment, nested conditions and RE2", async () => {
  const event = {
    source: "github",
    githubType: "github.check",
    id: "check-1",
    repository: githubRepository,
    payload: {
      action: "completed",
      check_run: { conclusion: "success", head_sha: reviewedSha, pull_requests: [{ number: 32 }] },
    },
  } as const;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(fixturePullRequest()))
      .mockResolvedValueOnce(Response.json(fixturePullRequest("b".repeat(40)))),
  );
  try {
    const signal = new AbortController().signal;
    const enriched = await enrichGithubCheck(event, "fixture", signal);
    expect(enriched.revision).toBe(reviewedSha);
    const trigger = {
      events: ["completed"],
      where: {
        all: [
          { "check-conclusion": "success", "pull-request-author": "dependabot[bot]" },
          { any: [{ title: { matches: "^bump" } }, { labels: { all: ["security"] } }] },
          { not: { draft: true } },
          { "changed-files": { lte: 3 }, "base-branch": "develop" },
        ],
      },
    };
    expect(matchesGitHubTrigger(githubFacts(enriched.payload), trigger)).toBe(true);
    const stale = await enrichGithubCheck(event, "fixture", signal);
    expect(matchesGitHubTrigger(githubFacts(stale.payload), trigger)).toBe(false);
    expect(stale.revision).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Automations Safe Actions require the allowed author, live SHA, checks, and exact mutation", async () => {
  const proposal =
    'MIXER_AUTOMATIONS_RESULT: {"version":1,"actions":[{"name":"github.pr.merge","input":{"version":1,"decision":"merge"}}]}';
  const event = {
    source: "github",
    githubType: "github.pull-request",
    id: "pr-32",
    repository: githubRepository,
    revision: reviewedSha,
    payload: { pull_request: fixturePullRequest() },
  } as const;
  const policy = {
    "github.pr.merge": {
      max: 1,
      allowedAuthors: ["dependabot[bot]"],
      method: "squash",
      mode: "immediate",
      minimumChecks: 1,
    },
  } as const;
  const action = prepareAction(
    proposal,
    {
      "github.pr.merge": {
        ...policy["github.pr.merge"],
        allowedAuthors: [...policy["github.pr.merge"].allowedAuthors],
      },
    },
    event,
  )!;
  expect(action).toMatchObject({ status: "proposed", sha: reviewedSha, number: 32 });
  expect(() => prepareAction(proposal, {}, event)).toThrow("did not authorize");
  const fetchFixture = vi
    .fn()
    .mockResolvedValueOnce(Response.json(fixturePullRequest("b".repeat(40))))
    .mockResolvedValueOnce(Response.json(fixturePullRequest()))
    .mockResolvedValueOnce(
      Response.json({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "success" }],
      }),
    )
    .mockResolvedValueOnce(Response.json({ total_count: 0, statuses: [] }))
    .mockResolvedValueOnce(Response.json({ merged: true }));
  vi.stubGlobal("fetch", fetchFixture);
  try {
    const signal = new AbortController().signal;
    await expect(validateAction(action, "fixture", signal)).rejects.toThrow("PR changed");
    expect(fetchFixture).toHaveBeenCalledTimes(1);
    await validateAction(action, "fixture", signal);
    await executeAction(action, "fixture", signal);
    expect(fetchFixture).toHaveBeenLastCalledWith(
      `https://api.github.com/repos/${githubRepository}/pulls/32/merge`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ sha: reviewedSha, merge_method: "squash" }),
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Automations Jira cadence keeps local time across daylight saving changes", () => {
  const date = nextJiraOccurrence(
    {
      cron: "0 9 * * 4",
      timezone: "Europe/Madrid",
      cadence: { startDate: "2026-10-22", everyWeeks: 2 },
      jql: "project = MIX",
      fields: [],
    },
    Date.parse("2026-10-22T09:00:00Z"),
  );
  expect(new Date(date).toISOString()).toBe("2026-11-05T08:00:00.000Z");
});

test("Automations repository checkout pins the activated commit without changing the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-automation-checkout-"));
  roots.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  await writeFile(path.join(source, "file"), "first");
  git("add", ".");
  git("commit", "-qm", "first");
  const first = git("rev-parse", "HEAD");
  await writeFile(path.join(source, "file"), "second");
  git("commit", "-qam", "second");
  const latest = git("rev-parse", "HEAD");
  vi.stubEnv("GIT_CONFIG_COUNT", "2");
  vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${source}.insteadOf`);
  vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/test-org/test-repo.git");
  vi.stubEnv("GIT_CONFIG_KEY_1", `url.file://${source}.insteadOf`);
  vi.stubEnv("GIT_CONFIG_VALUE_1", "https://forge.example.invalid/scm/test-org/test-repo.git");
  try {
    const checkout = path.join(root, "checkout");
    await expect(
      checkoutRepository(checkout, "test-org/test-repo", first, new AbortController().signal),
    ).resolves.toBe(first);
    expect(readFileSync(path.join(checkout, "file"), "utf8")).toBe("first");
    expect(git("rev-parse", "HEAD")).toBe(latest);
    const enterprise = path.join(root, "enterprise");
    await expect(
      checkoutRepository(
        enterprise,
        "test-org/test-repo",
        first,
        new AbortController().signal,
        "https://forge.example.invalid/scm",
      ),
    ).resolves.toBe(first);
    expect(readFileSync(path.join(enterprise, "file"), "utf8")).toBe("first");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Search is built-in, searches its owning workspace with bundled ripgrep, and reports invalid regex", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-search-"));
  roots.push(root);
  await writeFile(path.join(root, "source.ts"), "const reference = 1;\n");
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.14.0-beta.1",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["search"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    expect((await client.getPluginCatalog()).map((plugin) => plugin.id)).toEqual(["search"]);
    expect(await client.listPlugins()).toEqual([]);
    const created = await client.createWorkspace({ source: { kind: "directory", path: root } });
    if (!created.workspace) throw new Error("Workspace fixture was not created");
    const identity = {
      workspaceId: created.workspace.id,
      channelId: randomUUID(),
      requestId: randomUUID(),
    };
    const options = {
      query: "reference",
      regex: false,
      wholeWord: false,
      caseSensitive: false,
      includes: "",
      excludes: "",
      respectIgnore: true,
    };
    const result = resultSchema.parse(
      await client.invokePluginRpc("search", "search.text", { ...identity, options }),
    );
    expect(result.files).toEqual([
      {
        path: "source.ts",
        matches: [{ line: 1, column: 7, preview: "const reference = 1;", start: 6, end: 15 }],
      },
    ]);
    await expect(
      client.invokePluginRpc("search", "search.text", {
        ...identity,
        requestId: randomUUID(),
        options: { ...options, regex: true, query: "(" },
      }),
    ).rejects.toThrow(/regex parse error/);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("Source Control is available from the fork with external plugins disabled", async () => {
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.14.0-beta.1",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["source-control"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    expect(catalog.map((plugin) => plugin.id)).toEqual(["source-control"]);
    expect(catalog[0].clientBundle).toContain("Source Control");
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a built-in supersedes an old directory installation and survives disabling external plugins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-upgrade-"));
  roots.push(root);
  await fixture(root, "listed", true);
  const externalRoot = path.join(root, "external");
  const external = await fixture(externalRoot, "listed", true);
  await writeFile(
    path.join(external, "index.client.tsx"),
    "export default function contribute() { const marker = 'external-shadow-marker'; void marker; }",
  );
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: true,
    plugins: { listed: { source: "directory", path: external, enabled: true } },
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    expect(catalog.map((plugin) => plugin.id)).toEqual(["listed"]);
    expect(catalog[0].clientBundle).toContain("builtin-client-marker");
    expect(catalog[0].clientBundle).not.toContain("external-shadow-marker");
    expect(await client.listPlugins()).toEqual([]);
    await expect(client.disablePlugin("listed")).rejects.toThrow(/built-in/);
    await expect(client.reloadPlugin("listed")).rejects.toThrow(/built-in/);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await expect
      .poll(async () => (await client.getPluginCatalog()).map((plugin) => plugin.id))
      .toEqual(["listed"]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(root: string, id: string, client = false): Promise<string> {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "mixer-plugin.json"),
    JSON.stringify({ id, requirements: { mixer: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    "export default function contribute() { return () => {}; }",
  );
  if (client) {
    await writeFile(
      path.join(directory, "index.client.tsx"),
      "export default function contribute() { const marker = 'builtin-client-marker'; void marker; return () => {}; }",
    );
  }
  return directory;
}

test("listed built-ins resolve to matching manifests and compile", async () => {
  const root = resolveBuiltinPluginsRoot();
  for (const id of builtinPlugins) {
    const directory = path.join(root, id);
    expect((await readPluginManifest(directory)).id).toBe(id);
    const findEntry = async (names: string[]) => {
      for (const name of names) {
        const entry = path.join(directory, name);
        if ((await stat(entry).catch(() => null))?.isFile()) return entry;
      }
      return null;
    };
    const bundles = await compilePlugin({
      server: await findEntry(["index.server.ts", "index.server.tsx"]),
      client: await findEntry(["index.client.ts", "index.client.tsx"]),
    });
    expect(bundles.serverBundle).toBeTruthy();
  }
});

test("listed client bundle is published while plugins are disabled; unlisted directory is inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-fixture-"));
  roots.push(root);
  await fixture(root, "listed", true);
  await fixture(root, "unlisted", true);
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    expect(await client.listPlugins()).toEqual([]);
    const catalog = await client.getPluginCatalog();
    expect(catalog.map(({ id }) => id)).toEqual(["listed"]);
    expect(catalog[0]?.clientBundle).toContain("builtin-client-marker");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a repeated catalog fetch leaves out the client bundle the client already holds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-catalog-cache-"));
  roots.push(root);
  const directory = await fixture(root, "large", true);
  // About the size of a real plugin client bundle.
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `const payload = ${JSON.stringify("x".repeat(1_000_000))};
export default function contribute() { void payload; return () => {}; }`,
  );
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["large"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  const responseBytes: number[] = [];
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (message.type === "plugin.catalog.get.response") {
      responseBytes.push(JSON.stringify(message).length);
    }
  });
  try {
    await client.connect();
    const first = await client.getPluginCatalog();
    const second = await client.getPluginCatalog();

    expect(second).toEqual(first);
    expect(second[0]?.clientBundle).toContain("x".repeat(1_000_000));
    expect(responseBytes).toHaveLength(2);
    expect(responseBytes[0]).toBeGreaterThan(1_000_000);
    expect(responseBytes[1]).toBeLessThan(500);
  } finally {
    unsubscribe();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("directory, Git, and npm installs reject a built-in ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mixer-builtin-install-"));
  roots.push(root);
  const directory = await fixture(root, "reserved");
  const gitDirectory = await fixture(root, "git-source");
  await writeFile(
    path.join(gitDirectory, "mixer-plugin.json"),
    JSON.stringify({ id: "reserved", requirements: { mixer: ">=0.9.2" } }),
  );
  execFileSync("git", ["init", "-q", gitDirectory]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Mixer Tests",
    "-c",
    "user.email=mixer@example.test",
    "add",
    ".",
  ]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Mixer Tests",
    "-c",
    "user.email=mixer@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["reserved"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    await expect(client.installDirectoryPlugin(directory)).rejects.toThrow(
      /reserved for a built-in/,
    );
    await expect(
      client.installPluginSource({ source: pathToFileURL(gitDirectory).href }),
    ).rejects.toThrow(/reserved for a built-in/);
    await expect(
      client.installPluginSource({ source: "npm:unused-fixture", id: "reserved" }),
    ).rejects.toThrow(/reserved for a built-in/);
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
