import {
  renderReleaseNotes,
  getReleaseContext,
  writeReleaseChangelog,
  renderPreview,
} from "./mixer-release-notes.mjs";
import { updateReleasePreview } from "./update-release-preview.mjs";

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextReleaseVersion,
  getDesktopReleasePlan,
  getDesktopReleaseTag,
  getMergedReleaseMode,
  getMergedReleasePlan,
  getReleaseInfoFromSourceTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

test("computes the next beta patch from a stable version", () => {
  assert.equal(computeNextReleaseVersion("0.1.59", "beta-patch"), "0.1.60-beta.1");
});

test("advances beta versions", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.1", "beta-next"), "0.1.60-beta.2");
});

test("promotes beta versions to stable", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.2", "promote"), "0.1.60");
});

test("parses beta release metadata", () => {
  assert.deepEqual(parseReleaseVersion("0.1.60-beta.1"), {
    version: "0.1.60-beta.1",
    major: 0,
    minor: 1,
    patch: 60,
    prerelease: "beta.1",
    baseVersion: "0.1.60",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
  });
});

test("emits beta release info from tags", () => {
  assert.deepEqual(getReleaseInfoFromSourceTag("v0.1.60-beta.1"), {
    sourceTag: "v0.1.60-beta.1",
    releaseTag: "v0.1.60-beta.1",
    version: "0.1.60-beta.1",
    baseVersion: "0.1.60",
    prerelease: "beta.1",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
    releaseType: "prerelease",
    releaseChannel: "beta",
    isSmokeTag: false,
  });
});

test("rejects non-beta prerelease versions", () => {
  assert.throws(() => parseReleaseVersion("0.1.60-canary.1"), /Expected beta prerelease versions/);
});

test("desktop releases default to macOS and its stable update manifest", () => {
  assert.deepEqual(getDesktopReleasePlan("desktop-v0.1.1"), {
    platforms: ["macos"],
    manifestNames: ["latest-mac.yml"],
  });
});

test("a platform-specific tag selects only that platform", () => {
  assert.deepEqual(getDesktopReleasePlan("desktop-windows-v0.1.1"), {
    platforms: ["windows"],
    manifestNames: ["latest.yml"],
  });
});

test("manual platform selection overrides the tag platform", () => {
  assert.deepEqual(getDesktopReleasePlan("desktop-macos-v0.1.1", "linux"), {
    platforms: ["linux"],
    manifestNames: ["latest-linux.yml"],
  });
});

test("all-platform beta releases require exactly the beta manifests", () => {
  assert.deepEqual(getDesktopReleasePlan("desktop-v0.1.1-beta.1", "all"), {
    platforms: ["macos", "linux", "windows"],
    manifestNames: ["beta-mac.yml", "beta-linux.yml", "beta.yml"],
  });
});

test("rejects unknown desktop platforms and non-desktop source tags", () => {
  assert.throws(() => getDesktopReleasePlan("desktop-v0.1.1", "android"), /platform/);
  assert.throws(() => getDesktopReleasePlan("android-v0.1.1"), /desktop/);
});

test("desktop version tags do not trigger other product release workflows", () => {
  assert.equal(getDesktopReleaseTag("0.1.1"), "desktop-v0.1.1");
  assert.equal(getDesktopReleaseTag("0.1.1-beta.2"), "desktop-v0.1.1-beta.2");
});

test("merged PRs default to patch and honor an explicit release label", () => {
  assert.equal(getMergedReleaseMode([]), "patch");
  assert.equal(getMergedReleaseMode(["bug", "release:minor"]), "minor");
  assert.equal(getMergedReleaseMode(["release:major"]), "major");
  assert.equal(getMergedReleaseMode(["release:patch", "release:minor"]), "minor");
  assert.equal(getMergedReleaseMode(["release:minor", "release:major"]), "major");
});

test("merge release versions a detached snapshot and reuses its tag on retry", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(path.join(tmpdir(), "mixer-merge-release-"));
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
  const run = (cmd, args, env = {}) =>
    execFileSync(cmd, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, LEFTHOOK: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const script = fileURLToPath(new URL("./prepare-merged-desktop-release.mjs", import.meta.url));
  const output = path.join(dir, "output");
  try {
    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "0.1.0",
        private: true,
        workspaces: ["packages/app"],
        scripts: { version: "exit 99" },
      }),
    );
    writeFileSync(
      path.join(repo, "packages/app/package.json"),
      JSON.stringify({ name: "@fixture/app", version: "0.1.0", private: true }),
    );
    run("git", ["init", "-b", "main"]);
    run("git", ["config", "user.email", "test@example.com"]);
    run("git", ["config", "user.name", "Test"]);
    run("git", ["add", "."]);
    writeFileSync(
      path.join(repo, "CHANGELOG.md"),
      "# Changelog\n\n## 0.14.0 - 2026-10-27\nInherited upstream notes\n",
    );
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "initial imported source"]);
    writeFileSync(path.join(repo, "feature.txt"), "new Mixer feature");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "Add Mixer feature"]);
    const source = run("git", ["rev-parse", "HEAD"]);
    // develop can retain an older version than the most recent release tag.
    run("git", ["tag", "desktop-v0.1.4"]);
    run("git", ["checkout", "--detach", source]);
    run(process.execPath, [script], { GITHUB_OUTPUT: output, RELEASE_LABELS: "[]" });
    assert.match(readFileSync(output, "utf8"), /tag=desktop-v0.1.5/);
    assert.equal(run("git", ["rev-parse", "main"]), source);
    assert.match(
      readFileSync(path.join(repo, "CHANGELOG.md"), "utf8"),
      /^# Mixer Changelog\n\n## 0\.1\.5 - /,
    );
    const changelog = readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /Add Mixer feature/);
    assert.ok(!changelog.includes("Inherited upstream notes"));
    assert.equal(run("git", ["rev-parse", "desktop-v0.1.5^1"]), source);
    assert.equal(
      JSON.parse(readFileSync(path.join(repo, "packages/app/package.json"))).version,
      "0.1.5",
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(repo, "package-lock.json"))).packages[""].version,
      "0.1.5",
    );
    const release = run("git", ["rev-parse", "desktop-v0.1.5^{}"]);
    run("git", ["checkout", "--detach", source]);
    run(process.execPath, [script], { GITHUB_OUTPUT: output, RELEASE_LABELS: "[]" });
    assert.equal(run("git", ["rev-parse", "desktop-v0.1.5^{}"]), release);
    assert.equal(run("git", ["tag", "--list", "desktop-v0.1.6"]), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview and release use the same version plan, including forced labels and allocated tags", () => {
  const input = {
    currentVersion: "0.1.0",
    tags: ["desktop-v0.1.4", "desktop-v0.2.0-beta.1"],
    labels: [],
  };
  assert.equal(getMergedReleasePlan(input).version, "0.1.5");
  assert.equal(
    getMergedReleasePlan({ ...input, labels: ["release:minor", "release:patch"] }).version,
    "0.2.0",
  );
  assert.equal(
    getMergedReleasePlan({ ...input, labels: ["release:major", "release:minor"] }).version,
    "1.0.0",
  );
});
test("release notes use explicit feature notes and direct commit summaries", () => {
  const notes = renderReleaseNotes([
    {
      number: 12,
      title: "Editor",
      body: "## Release notes\n\n- Added editor search\n- Added split views\n\n## Testing\nnot notes",
      url: "https://github.com/owner/mixer/pull/12",
    },
    {
      sha: "abcdef123",
      title: "Fix startup",
      url: "https://github.com/owner/mixer/commit/abcdef123",
    },
  ]);
  for (const text of ["Added editor search", "Added split views", "Fix startup"])
    assert.ok(notes.includes(text));
  assert.ok(!notes.includes("not notes"));
});
test("only Mixer history enters the versioned changelog", () => {
  assert.throws(
    () =>
      writeReleaseChangelog({
        version: "0.1.1",
        date: "2026-11-02",
        notes: "- Own change",
        previous: "# Changelog\n\n## 0.14.0 - 2026-10-27\nUpstream",
      }),
    /non-Mixer/,
  );
  const text = writeReleaseChangelog({
    version: "0.1.2",
    date: "2026-11-02",
    notes: "- Own change",
    previous: "# Mixer Changelog\n\n## 0.1.1 - 2026-11-01\n\n- Previous Mixer change\n",
  });
  assert.match(text, /## 0\.1\.2 - 2026-11-02/);
  assert.match(text, /Previous Mixer change/);
  assert.match(
    renderPreview({
      plan: { mode: "patch", version: "0.1.2" },
      notes: "- Own change",
      head: "abc",
      baseline: "v0.1.1",
    }),
    /Mixer release preview: 0.1.2/,
  );
});
test("a single preview comment updates on labels and commits and ignores stale runs and forks", () => {
  const repo = "owner/mixer";
  let pr = {
    number: 9,
    state: "open",
    head: { sha: "a".repeat(40), ref: "develop", repo: { full_name: repo } },
    base: { ref: "main", sha: "b".repeat(40) },
    labels: [],
    body: "## Release notes\n- Feature A",
  };
  let comment;
  let writes = 0;
  let stale = false;
  let reads = 0;
  const api = (endpoint, options = {}) => {
    if (endpoint.endsWith("/pulls/9")) {
      reads++;
      return structuredClone(stale && reads % 2 === 0 ? { ...pr, body: "changed" } : pr);
    }
    if (endpoint.endsWith("/comments?per_page=100")) return comment ? [comment] : [];
    writes++;
    comment = { id: 123, user: { login: "github-actions[bot]" }, body: options.data.body };
    return comment;
  };
  const contextFor = ({ source, labels, releasePr }) => ({
    plan: getMergedReleasePlan({ currentVersion: "0.1.1", tags: [], labels }),
    notes: renderReleaseNotes([], releasePr.body),
    head: source,
    baseline: null,
  });
  const run = () => updateReleasePreview({ repo, number: "9", api, runGit() {}, contextFor });
  run();
  assert.equal(writes, 1);
  assert.match(comment.body, /0.1.2/);
  run();
  assert.equal(writes, 1);
  pr.labels = [{ name: "release:minor" }];
  run();
  assert.equal(writes, 2);
  assert.match(comment.body, /0.2.0/);
  pr.head.sha = "c".repeat(40);
  pr.body = "## Release notes\n- Feature B";
  run();
  assert.equal(writes, 3);
  assert.match(comment.body, /Feature B/);
  assert.equal(comment.id, 123);
  stale = true;
  run();
  assert.equal(writes, 3);
  stale = false;
  pr.head.repo.full_name = "outsider/mixer";
  run();
  assert.equal(writes, 3);
});

test("PR section headings cannot become extra IDE releases", () => {
  const notes = renderReleaseNotes([
    {
      number: 4,
      title: "Feature",
      body: "## Summary\n- Added feature\n\n## Testing\nnot notes",
      url: "https://github.com/owner/mixer/pull/4",
    },
  ]);
  assert.match(notes, /### Changed/);
  assert.ok(
    !notes.includes("Added feature"),
    "Uncurated PR descriptions do not enter the changelog",
  );
  assert.ok(!/^## /m.test(notes));
  assert.ok(!notes.includes("not notes"));
});

test("empty PR templates do not become release features", () => {
  const notes = renderReleaseNotes([
    {
      number: 2,
      title: "Fix editor startup",
      body: "### Linked issue\nCloses #\n\n## Type of change\n- [ ] Bug fix\n\n## Reasoning\n\n## Testing\n- [ ] tests",
      url: "https://github.com/owner/mixer/pull/2",
    },
  ]);
  assert.match(notes, /Fix editor startup/);
  assert.ok(!notes.includes("Linked issue"));
  assert.ok(!notes.includes("Reasoning"));
  assert.ok(!notes.includes("Closes #"));
  assert.ok(!notes.includes("[ ]"));
});

test("curated release notes replace generated notes and repeated items are deduplicated", () => {
  const change = {
    title: "Fix editor startup",
    number: 4,
    url: "https://github.com/owner/mixer/pull/4",
    body: "Long implementation details",
  };
  const notes = renderReleaseNotes([change, change]);
  assert.equal(notes.match(/Fix editor startup/g).length, 1);
  assert.match(notes, /### Fixed/);
  assert.ok(!notes.includes("implementation"));
  const curated = renderReleaseNotes(
    [change],
    "## Release notes\n### Added\n- Editor split views\n## Testing\nInternal details",
  );
  assert.match(curated, /### Added/);
  assert.ok(!curated.includes("Fix editor startup"));
});

test("release context excludes published commits and preserves corrected asset history", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "mixer-release-boundary-"));
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const run = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    run("init", "-b", "main");
    run("config", "user.name", "Release test");
    run("config", "user.email", "test@example.test");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(
      join(directory, "CHANGELOG.md"),
      "# Mixer Changelog\n\n## 1.0.0 - 2026-11-01\n\nRaw old implementation details\n",
    );
    run("add", ".");
    run("-c", "commit.gpgsign=false", "commit", "-m", "feat: previously published feature");
    run("tag", "v1.0.0");
    run("tag", "desktop-v1.0.0");
    run("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fix: new startup repair");
    const head = run("rev-parse", "HEAD");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const corrected =
      "# Mixer Changelog\n\n## 1.0.0 - 2026-11-01\n\n### Added\n\n- Corrected published feature\n";
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env node
const endpoint = process.argv[3];
if (endpoint.endsWith('/releases/assets/42')) process.stdout.write(${JSON.stringify(corrected)});
else if (endpoint.includes('/releases?')) console.log(JSON.stringify([[{ tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [{name:'CHANGELOG.md',id:42}] }]]));
else if (endpoint.includes('/commits/${head}/pulls')) console.log(JSON.stringify([[{ number:7,title:'Fix new startup repair',body:'Do not copy full PR implementation details',html_url:'https://github.com/matthewcalcagno/mixer/pull/7',merged_at:'2026-11-02',head:{ref:'fix/startup'},base:{ref:'develop',repo:{full_name:'matthewcalcagno/mixer'}} }]]));
else throw new Error('Unexpected request, possibly a previously published commit: '+endpoint);
`,
      { mode: 0o755 },
    );
    process.chdir(directory);
    process.env.PATH = `${bin}:${previousPath}`;
    const context = getReleaseContext({ source: head, labels: [], repo: "matthewcalcagno/mixer" });
    assert.equal(context.baseline, "v1.0.0");
    assert.equal(context.plan.version, "1.0.1");
    assert.match(context.notes, /Fix new startup repair/);
    assert.ok(!context.notes.includes("published feature"));
    assert.ok(!context.notes.includes("implementation details"));
    assert.equal(context.previous, corrected);
    assert.match(context.notes, /compare\/v1\.0\.0\.\.\.v1\.0\.1/);
  } finally {
    process.chdir(previousCwd);
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
