import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { createHmac, randomUUID } from "node:crypto";
import { resultSchema } from "../../../../../../plugins/search/shared/search.js";

import { checkoutRepository } from "../../../../../../plugins/automations/server/checkout.js";

import { pollGithubRepository } from "../../../../../../plugins/automations/server/github-poll.js";
import { nextJiraOccurrence } from "../../../../../../plugins/automations/server/definition.js";

import { githubFacts } from "../../../../../../plugins/automations/server/github-facts.js";
import { matchesGitHubTrigger } from "../../../../../../plugins/automations/server/github-matcher.js";
import { enrichGithubCheck } from "../../../../../../plugins/automations/server/github-enrichment.js";
import {
  executeAction,
  prepareAction,
  validateAction,
} from "../../../../../../plugins/automations/server/safe-actions.js";

const roots: string[] = [];

test("every bundled plugin starts on the current Mixer release", async () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../../../../../../package.json", import.meta.url), "utf8"),
  );
  const daemon = await createTestMixerDaemon({
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
  const daemon = await createTestMixerDaemon({
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
    const root = path.join(daemon.mixerHome, "automations");
    await expect.poll(async () => (await stat(root).catch(() => null))?.isDirectory()).toBe(true);
    expect(await client.invokePluginRpc("automations", "automations.workflows.list", {})).toEqual({
      workflows: [],
      limited: false,
    });
    await expect(
      client.invokePluginRpc("automations", "automations.workflows.create", {
        name: "review",
      }),
    ).resolves.toMatchObject({ path: "review.md", workspaceId: expect.any(String) });
    expect(readFileSync(path.join(root, "review.md"), "utf8")).toContain("disabled: true");
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
    const script =
      "name: Smoke run\non: {schedule: {cron: '* * * * * *'}}\nsteps:\n  - run: echo mixer-automation\n";
    await writeFile(path.join(root, "smoke.yaml"), script);
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
    const { agentId } = (await client.invokePluginRpc("automations", "automations.chat.open", {
      path: "review.md",
    })) as { agentId: string };
    await expect(client.fetchAgent({ agentId })).resolves.toMatchObject({
      agent: { id: agentId, provider: "codex", cwd: await realpath(root) },
    });
    await expect
      .poll(async () => (await stat(expiredPath).catch(() => null))?.isFile() ?? false)
      .toBe(false);
    await expect
      .poll(() => client.invokePluginRpc("automations", "automations.runs.list", {}), {
        timeout: 12_000,
      })
      .toMatchObject({
        runs: expect.arrayContaining([
          expect.objectContaining({ path: "smoke.yaml", trigger: "schedule", status: "succeeded" }),
          expect.objectContaining({ id, status: "succeeded" }),
        ]),
      });
  } finally {
    await client.close();
    await daemon.close();
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

test("Automations routes authenticated webhooks, polls Jira, and imports RoboPlane idempotently", async () => {
  vi.stubEnv("MIXER_TEST_WEBHOOK", "test-webhook-secret");
  vi.stubEnv("MIXER_TEST_GITHUB", "test-github-secret");
  vi.stubEnv("MIXER_TEST_JIRA", "test-jira-token");
  const jira = await localListener((request, response) => {
    if (
      request.url !== "/jira/rest/api/2/search" ||
      request.headers.authorization !== "Bearer test-jira-token"
    ) {
      response.writeHead(401).end();
      return;
    }
    request.resume();
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        startAt: 0,
        maxResults: 50,
        total: 1,
        issues: [
          {
            id: "12",
            key: "MIX-12",
            fields: { summary: "Jira fixture", updated: "2026-01-01T00:00:00Z" },
          },
        ],
      }),
    );
  });
  const address = await localListener();
  await address.close();
  const daemon = await createTestMixerDaemon({
    daemonVersion: "0.14.0-beta.1",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["automations"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    const invoke = (method: string, input: Record<string, unknown> = {}) =>
      client.invokePluginRpc("automations", method, input);
    const root = path.join(daemon.mixerHome, "automations");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "events.yaml"),
      [
        "name: Event fixture",
        "repository: test-org/test-repo",
        "workspace: scratch",
        "on:",
        "  webhook.received: {endpoints: [build], payload: {status: [failed]}}",
        "  github.issue: {events: [opened], where: {labels: {all: [automation]}}}",
        "  jira.issue: {cron: '* * * * * *', jql: 'project = MIX'}",
        "steps:",
        '  - run: cat "$MIXER_EVENT_FILE"',
      ].join("\n"),
    );
    const { revision } = (await invoke("settings.preferences.read")) as { revision: string };
    await expect(
      invoke("settings.preferences.write", {
        revision,
        values: {
          schedulesEnabled: true,
          integrations: {
            webhookPort: address.port,
            webhookSecretEnv: "MIXER_TEST_WEBHOOK",
            githubSecretEnv: "MIXER_TEST_GITHUB",
            jiraBaseUrl: `${jira.url}/jira`,
            jiraTokenEnv: "MIXER_TEST_JIRA",
          },
        },
      }),
    ).resolves.toMatchObject({ status: "saved" });
    const submit = (route: string, body: string, headers: Record<string, string>) =>
      fetch(`${address.url}/webhooks/${route}`, { method: "POST", headers, body });
    await expect
      .poll(
        async () => {
          try {
            return (await submit("build", "{}", {})).status;
          } catch {
            return 0;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(401);
    const generic = {
      authorization: "Bearer test-webhook-secret",
      "x-delivery-id": "same-delivery",
    };
    expect((await submit("build", '{"status":"passed"}', generic)).status).toBe(202);
    expect((await submit("build", '{"status":"failed"}', generic)).status).toBe(202);
    expect((await submit("build", '{"status":"failed"}', generic)).status).toBe(202);

    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "test-org/test-repo" },
      issue: { labels: [{ name: "automation" }] },
    });
    const signature = `sha256=${createHmac("sha256", "test-github-secret").update(body).digest("hex")}`;
    const github = { "x-github-event": "issues", "x-hub-signature-256": signature };
    expect((await submit("github", body + " ", github)).status).toBe(401);
    expect((await submit("github", body, github)).status).toBe(202);
    expect((await submit("github", body, github)).status).toBe(202);
    const history = () =>
      invoke("automations.runs.list") as Promise<{
        runs: { trigger: string; status: string; id: string }[];
      }>;
    await expect
      .poll(
        async () =>
          (await history()).runs
            .filter(({ status }) => status === "succeeded")
            .map(({ trigger }) => trigger)
            .sort(),
        { timeout: 12_000 },
      )
      .toEqual(["github", "jira", "webhook"]);

    await writeFile(
      path.join(root, "review.yaml"),
      [
        "name: Review fixture",
        `repository: ${githubRepository}`,
        "workspace: scratch",
        "on: {github.pull-request: {events: [opened]}}",
        "safeActions: {github.pr.approve: {max: 1, allowedAuthors: ['dependabot[bot]']}}",
        "steps:",
        "  - run: |",
        `      printf '%s\\n' 'MIXER_RESULT: {"version":1,"actions":[{"name":"github.pr.approve","input":{"version":1,"decision":"approve"}}]}'`,
      ].join("\n"),
    );
    const review = JSON.stringify({
      action: "opened",
      repository: { full_name: githubRepository },
      pull_request: fixturePullRequest(),
    });
    const signed = `sha256=${createHmac("sha256", "test-github-secret").update(review).digest("hex")}`;
    expect(
      (
        await submit("github", review, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": signed,
        })
      ).status,
    ).toBe(202);
    await expect.poll(history).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          path: "review.yaml",
          status: "succeeded",
          action: expect.objectContaining({
            name: "github.pr.approve",
            status: "proposed",
            sha: reviewedSha,
          }),
        }),
      ]),
    });

    const source = path.join(daemon.mixerHome, "roboplane-fixture");
    const state = path.join(source, ".roboplane", "state");
    const logs = path.join(source, ".roboplane", "logs");
    await mkdir(state, { recursive: true });
    await mkdir(logs);
    await mkdir(path.join(source, "automations"));
    const file = path.join(source, "automations", "legacy.md");
    const original = "---\nname: Legacy workflow\n---\nSummarize fixture.\n";
    await writeFile(file, original);
    await writeFile(path.join(logs, "legacy-id.log"), "legacy output");
    const db = new DatabaseSync(path.join(state, "roboplane.db"));
    try {
      db.exec(
        "CREATE TABLE runs(id TEXT, workflow_id TEXT, repository TEXT, status TEXT, error TEXT, created_at TEXT, updated_at TEXT)",
      );
      db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "legacy-id",
        "legacy.md",
        null,
        "completed",
        null,
        "2026-01-01",
        "2026-01-02",
      );
    } finally {
      db.close();
    }
    const migrate = () => invoke("automations.import.roboplane", { home: source });
    await expect(migrate()).resolves.toEqual({ workflows: 1, runs: 1, skipped: 0 });
    await expect(migrate()).resolves.toEqual({ workflows: 0, runs: 0, skipped: 2 });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(path.join(root, "legacy.md"), "utf8")).toContain("disabled: true");
    const imported = (await history()).runs.find(({ trigger }) => trigger === "imported")!;
    await expect(invoke("automations.runs.get", { id: imported.id })).resolves.toMatchObject({
      importedId: "legacy-id",
      status: "succeeded",
      sourceStatus: "completed",
      output: "legacy output",
    });
  } finally {
    await client.close();
    await daemon.close();
    await jira.close();
    vi.unstubAllEnvs();
  }
}, 60_000);

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
    'MIXER_RESULT: {"version":1,"actions":[{"name":"github.pr.merge","input":{"version":1,"decision":"merge"}}]}';
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
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${source}.insteadOf`);
  vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/test-org/test-repo.git");
  try {
    const checkout = path.join(root, "checkout");
    await expect(
      checkoutRepository(checkout, "test-org/test-repo", first, new AbortController().signal),
    ).resolves.toBe(first);
    expect(readFileSync(path.join(checkout, "file"), "utf8")).toBe("first");
    expect(git("rev-parse", "HEAD")).toBe(latest);
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
