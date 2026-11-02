import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  ["server-tests-macos", { name: "server-tests (macos-15, file observation)", contract: "server" }],
  [
    "desktop-tests-ubuntu",
    { name: "desktop-tests (ubuntu-latest)", contracts: ["desktop", "browser"] },
  ],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["playwright-1", { name: "playwright (shard 1/8)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/8)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/8)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/8)", contract: "browser" }],
  ["playwright-5", { name: "playwright (shard 5/8)", contract: "browser" }],
  ["playwright-6", { name: "playwright (shard 6/8)", contract: "browser" }],
  ["playwright-7", { name: "playwright (shard 7/8)", contract: "browser" }],
  ["playwright-8", { name: "playwright (shard 8/8)", contract: "browser" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [
    ciWorkflowPath,
    new URL(".github/workflows/desktop-packages.yml", repoRoot),
  ]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
    "a newer push to any ref, main included, cancels the superseded run",
  );
  for (const workflowPath of [ciWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@mixer\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@mixer\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("ordinary CI keeps app tests without prebuilding Android modules", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const app = jobBlocks(source).get("app-tests").join("\n");
  assert.match(app, /npm run build:app-deps/);
  assert.match(app, /npm run test --workspace=@mixer\/app/);
  assert.doesNotMatch(source, /test:android|expo prebuild|gradlew|actions\/setup-java/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/**/*.electron.{ts,tsx}",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "plugins/*/client/**",
      "plugins/*/index.client.{ts,tsx}",
      "plugins/*/shared/**",
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /mixerDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "plugins/*/client/**",
    "plugins/*/index.client.{ts,tsx}",
    "plugins/*/shared/**",
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("desktop distribution does not deploy separate services or alternative packages", () => {
  const workflows = filesUnder(".github/workflows", (file) => /\.ya?ml$/.test(file));
  for (const name of [
    "deploy-app",
    "deploy-relay",
    "deploy-website",
    "docker",
    "nix",
    "nix-update-hash",
  ])
    assert.ok(
      !workflows.includes(`.github/workflows/${name}.yml`),
      `${name} is outside desktop distribution`,
    );
  for (const name of [
    "ci",
    "desktop-packages",
    "desktop-release",
    "desktop-release-on-merge",
    "desktop-rollout",
    "release-notes-sync",
    "release-preview",
  ])
    assert.ok(
      workflows.includes(`.github/workflows/${name}.yml`),
      `${name} is required for desktop delivery`,
    );
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("desktop-only workspaces have no mobile targets, native app modules, or store workflows", () => {
  const root = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));
  const renderer = JSON.parse(readFileSync(new URL("packages/app/package.json", repoRoot), "utf8"));
  assert.equal(root.workspaces.includes("packages/expo-two-way-audio"), false);
  for (const manifest of [root, renderer]) {
    assert.deepEqual(
      Object.keys(manifest.scripts).filter((key) =>
        /android|ios|apk|fdroid|mobile|eas-build/.test(key),
      ),
      [],
    );
  }
  for (const target of [
    "packages/app/ios",
    "packages/app/android",
    "packages/app/modules",
    "packages/app/.eas",
    "packages/app/eas.json",
    "packages/server/src/server/push",
    ".github/workflows/android-apk-release.yml",
  ]) {
    assert.equal(existsSync(new URL(target, repoRoot)), false, `${target} must remain retired`);
  }
  const sourceFiles = readdirSync(new URL("packages/app/src", repoRoot), { recursive: true });
  assert.deepEqual(
    sourceFiles.filter((file) => /\.(native|ios|android)\.[jt]sx?$/.test(file)),
    [],
  );
});

test("eight Playwright shards share two-worker coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  assert.equal(jobs.size, 21);
  for (let shard = 1; shard <= 8; shard++) {
    const job = jobs.get(`playwright-${shard}`).join("\n");
    assert.match(job, new RegExp(`PLAYWRIGHT_SHARD: "${shard}/8"`));
    assert.match(job, new RegExp(`PLAYWRIGHT_ARTIFACT: "${shard}"`));
    assert.match(
      job,
      shard === 1 ? /steps: &playwright_test_steps/ : /steps: \*playwright_test_steps/,
    );
  }
  const shared = jobs.get("playwright-1").join("\n");
  assert.match(shared, /E2E_WORKERS: "2"/);
  const weights = /PWTEST_SHARD_WEIGHTS: "([\d:]+)"/.exec(shared)[1].split(":").map(Number);
  assert.equal(weights.length, 8);
  assert.ok(weights.every((weight) => weight > 0));
  assert.match(shared, /npm run test:e2e --workspace=@mixer\/app -- --shard=/);

  // No fan-in result job: a gate needs its own runner and under contention it
  // queued 8m08s behind the last shard. Required checks name the shards directly.
  assert.equal(jobs.has("playwright"), false);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/mixer-plugin.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@mixer/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@mixer/plugin",
      "npm run test --workspace=@mixer/protocol",
      "npm run test --workspace=@mixer/client",
      "npm run test --workspace=@mixer/highlight",
      "npm run typecheck:examples --workspace=@mixer/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@mixer\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@mixer\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@mixer\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(job, /^    needs: changes$/m, "both phases become eligible independently");
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@mixer\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@mixer\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/agent/providers/omp/history.e2e.test.ts src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses|replays selected OMP history"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  assert.doesNotMatch(serverConfig, /maxWorkers/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      cancelled: () => cancelled,
    });
  }
  const unitCondition = condition(windows);
  const integrationCondition = condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    assert.equal(selected(unitCondition, outputs), units);
    assert.equal(selected(integrationCondition, outputs), integrations);
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    assert.equal(selected(unitCondition, outputs, true), false);
    assert.equal(selected(integrationCondition, outputs, true), false);
  }
});

test("macOS release retries only transient stapling failures without rebuilding the signed app", async (t) => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const wrapper = workflow
    .match(/<<'STAPLER'\n([\s\S]*?)\n          STAPLER/)[1]
    .replace(/^          /gm, "");
  const networkError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const cases = [
    {
      name: "success",
      outcomes: [0],
      output: "stapled",
      command: "stapler",
      expected: 0,
      attempts: 1,
    },
    {
      name: "transient then success",
      outcomes: [68, 0],
      output: networkError,
      command: "stapler",
      expected: 0,
      attempts: 2,
    },
    {
      name: "exhausted network retries",
      outcomes: [68, 68, 68, 68, 0],
      output: networkError,
      command: "stapler",
      expected: 68,
      attempts: 4,
    },
    {
      name: "non-network staple error",
      outcomes: [68, 0],
      output: "ticket not found",
      command: "stapler",
      expected: 68,
      attempts: 1,
    },
    {
      name: "different exit code",
      outcomes: [1, 0],
      output: networkError,
      command: "stapler",
      expected: 1,
      attempts: 1,
    },
    {
      name: "notary submission is not retried",
      outcomes: [68, 0],
      output: networkError,
      command: "notarytool",
      expected: 68,
      attempts: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "stapler-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(
          statePath,
          JSON.stringify({ outcomes: scenario.outcomes, output: scenario.output, calls: [] }),
        );
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STAPLER_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const code = state.outcomes.shift();
fs.writeFileSync(process.env.STAPLER_STATE, JSON.stringify(state));
console.log(state.output);
process.exit(code);
`,
          { mode: 0o755 },
        );
        const args = [scenario.command, "staple", "-v", "Mixer signed.app"];
        const result = spawnSync("bash", [wrapperPath, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            MIXER_REAL_XCRUN: realXcrun,
            STAPLER_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(
          state.calls,
          Array.from({ length: scenario.attempts }, () => args),
        );
        assert.match(result.stdout, /stapled|network connection was lost|ticket not found/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("desktop releases only accept merged develop-to-main PRs from this repository", () => {
  const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const caller = readFileSync(
    new URL(".github/workflows/desktop-release-on-merge.yml", repoRoot),
    "utf8",
  );
  const triggers = (source) =>
    [
      ...source
        .split("\non:\n")[1]
        .split("\nconcurrency:")[0]
        .matchAll(/^  ([a-z_]+):/gm),
    ].map((match) => match[1]);
  assert.deepEqual(triggers(release), ["workflow_call"]);
  assert.deepEqual(triggers(caller), ["pull_request"]);
  assert.match(caller, /branches: \[main\]/);
  assert.match(caller, /types: \[closed\]/);
  const allowed = {
    event_name: "pull_request",
    repository: "owner/mixer",
    event: {
      action: "closed",
      pull_request: {
        merged: true,
        base: { ref: "main" },
        head: { ref: "develop", repo: { full_name: "owner/mixer" } },
      },
    },
  };
  const cases = [
    [allowed, true],
    [{ ...allowed, event_name: "push" }, false],
    [{ ...allowed, event_name: "workflow_dispatch" }, false],
    [{ ...allowed, event: { ...allowed.event, action: "opened" } }, false],
    ...[
      { merged: false },
      { base: { ref: "develop" } },
      { head: { ref: "feature", repo: { full_name: "owner/mixer" } } },
      { head: { ref: "develop", repo: { full_name: "outsider/mixer" } } },
    ].map((override) => [
      {
        ...allowed,
        event: { ...allowed.event, pull_request: { ...allowed.event.pull_request, ...override } },
      },
      false,
    ]),
  ];
  for (const [source, job] of [
    [release, "prepare"],
    [caller, "version"],
  ]) {
    const block = jobBlocks(source).get(job).join("\n");
    const condition = /    if: >-\n((?:      .*\n)+)/.exec(`${block}\n`)?.[1];
    assert.ok(condition, `${job} must guard its event`);
    for (const [github, expected] of cases)
      assert.equal(
        runInNewContext(condition, { github }),
        expected,
        `${job}: ${JSON.stringify(github)}`,
      );
  }
  const callers = filesUnder(".github/workflows", (file) => /\.ya?ml$/.test(file)).filter((file) =>
    /uses: \.\/\.github\/workflows\/desktop-release\.yml/.test(
      readFileSync(new URL(file, repoRoot), "utf8"),
    ),
  );
  assert.deepEqual(callers, [".github/workflows/desktop-release-on-merge.yml"]);
});

test("release preview runs helpers from its trusted workflow revision, including the first promotion", () => {
  const source = readFileSync(new URL(".github/workflows/release-preview.yml", repoRoot), "utf8");
  assert.match(source, /pull_request_target:/);
  for (const event of ["synchronize", "edited", "labeled", "unlabeled"])
    assert.ok(source.includes(event));
  assert.match(source, /ref: \$\{\{ github\.workflow_sha \}\}/);
  const checkoutRef = /ref: \$\{\{ (.*?) \}\}/.exec(source)[1];
  assert.equal(
    runInNewContext(checkoutRef, {
      github: {
        workflow_sha: "trusted-definition-with-preview-script",
        sha: "event-commit",
        event: {
          pull_request: {
            base: { sha: "main-before-preview-was-added" },
            head: { sha: "untrusted-pr-head" },
          },
        },
      },
    }),
    "trusted-definition-with-preview-script",
  );

  assert.doesNotMatch(source, /ref:.*pull_request\.(?:base|head)\.sha/);
  assert.doesNotMatch(
    source,
    /ref:.*head|npm (ci|install)|secrets\.APPLE|pull_request_target.*checkout.*head/,
  );
  assert.match(source, /pull-requests: write/);
  assert.match(source, /run: node scripts\/update-release-preview\.mjs/);
});

test("desktop release tags are published before release creation and cannot be retargeted", () => {
  const caller = readFileSync(
    new URL(".github/workflows/desktop-release-on-merge.yml", repoRoot),
    "utf8",
  );
  const step = caller.split("      - name: Push desktop release tag\n")[1].split("\n  release:")[0];
  const shell = step
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const create = release.split('gh release create "$RELEASE_TAG"')[1].split("      - name:")[0];
  assert.match(create, /--verify-tag/);
  assert.doesNotMatch(create, /--target/);
  const root = mkdtempSync(join(tmpdir(), "mixer-release-tags-"));
  const cwd = join(root, "checkout");
  const remote = join(root, "remote.git");
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", cwd, ...options });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  try {
    mkdirSync(cwd);
    run("git", ["init", "--bare", remote]);
    run("git", ["init", "-b", "main"]);
    run("git", ["config", "user.name", "Release test"]);
    run("git", ["config", "user.email", "release@example.test"]);
    run("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "release"]);
    run("git", ["tag", "-a", "desktop-v1.2.3", "-m", "release"]);
    run("git", ["remote", "add", "origin", remote]);
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(
      join(cwd, "scripts/release-version-utils.mjs"),
      readFileSync(new URL("scripts/release-version-utils.mjs", repoRoot)),
    );
    const env = { ...process.env, RELEASE_TAG: "desktop-v1.2.3" };
    run("bash", ["-e", "-c", shell], { env });
    const expected = run("git", ["rev-parse", "HEAD"]);
    for (const tag of ["desktop-v1.2.3", "v1.2.3"])
      assert.equal(run("git", ["rev-parse", `${tag}^{commit}`], { cwd: remote }), expected);
    run("bash", ["-e", "-c", shell], { env });
    run("git", ["tag", "-d", "v1.2.3"]);
    run("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "other"]);
    run("git", ["tag", "v1.2.3"]);
    const rejected = spawnSync("bash", ["-e", "-c", shell], { cwd, env, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.equal(run("git", ["rev-parse", "v1.2.3^{commit}"], { cwd: remote }), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop renderer edits retain broad UI coverage and exercise real Electron", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const desktop = jobs.get("desktop-tests-ubuntu").join("\n");
  const windows = jobs.get("desktop-tests-windows").join("\n");
  assert.match(desktop, /needs\.changes\.outputs\.browser != 'false'/);
  for (const command of [
    "test:e2e:window-startup",
    "test:e2e:lifecycle",
    "test:e2e:browser-tabs",
    "test:e2e:renderer",
  ])
    assert.ok(desktop.includes(command), `desktop checks must retain ${command}`);
  assert.match(desktop, /packages\/desktop\/test-results\//);
  assert.match(windows, /needs\.changes\.outputs\.desktop != 'false'/);
  assert.equal([...jobs.keys()].filter((name) => /^playwright-[1-8]$/.test(name)).length, 8);
  const browser = loadFilters(filtersPath).browser;
  for (const path of [
    "plugins/*/client/**",
    "plugins/*/index.client.{ts,tsx}",
    "plugins/*/shared/**",
  ])
    assert.ok(browser.includes(path), `plugin UI changes must select renderer tests: ${path}`);
});
