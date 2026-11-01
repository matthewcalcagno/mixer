import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextReleaseVersion,
  getDesktopReleasePlan,
  getDesktopReleaseTag,
  getMergedReleaseMode,
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
  assert.throws(() => getMergedReleaseMode(["release:patch", "release:minor"]), /only one/);
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
    run("git", ["commit", "-m", "merged source"]);
    const source = run("git", ["rev-parse", "HEAD"]);
    // develop can retain an older version than the most recent release tag.
    run("git", ["tag", "desktop-v0.1.4"]);
    run("git", ["checkout", "--detach", source]);
    run(process.execPath, [script], { GITHUB_OUTPUT: output, RELEASE_LABELS: "[]" });
    assert.match(readFileSync(output, "utf8"), /tag=desktop-v0.1.5/);
    assert.equal(run("git", ["rev-parse", "main"]), source);
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
