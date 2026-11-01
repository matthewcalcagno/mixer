import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextReleaseVersion,
  getDesktopReleasePlan,
  getDesktopReleaseTag,
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
