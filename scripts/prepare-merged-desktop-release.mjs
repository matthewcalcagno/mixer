import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  computeNextReleaseVersion,
  getDesktopReleaseTag,
  getMergedReleaseMode,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const runNpm = (...args) => execFileSync("npm", args, { stdio: "inherit" });
const source = git("rev-parse", "HEAD");
const mode = getMergedReleaseMode(JSON.parse(process.env.RELEASE_LABELS || "[]"));
const tags = git("tag", "--list", "desktop-v*", "--sort=-version:refname")
  .split("\n")
  .filter(Boolean);

// A rerun must build the original release, even if another merge has since shipped.
const existing = tags.find((tag) =>
  git("rev-list", "--parents", "-n", "1", tag).split(" ").slice(1).includes(source),
);
let tag = existing;
if (!tag) {
  if (git("status", "--porcelain"))
    throw new Error("Release preparation requires a clean checkout");
  const current = JSON.parse(readFileSync("package.json", "utf8")).version;
  const versions = [current, ...tags.map((name) => name.slice("desktop-v".length))];
  const stable = versions
    .map(parseReleaseVersion)
    .filter((version) => !version.isPrerelease)
    .sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
  if (!stable.length) throw new Error("Merge releases require an existing stable version");
  const version = computeNextReleaseVersion(stable[0].version, mode);
  tag = getDesktopReleaseTag(version);
  // Skip local version hooks: they stage the entire checkout and create a branch commit.
  runNpm(
    "version",
    version,
    "--workspaces",
    "--include-workspace-root",
    "--no-git-tag-version",
    "--ignore-scripts",
    "--allow-same-version",
  );
  runNpm("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund");
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git(
    "add",
    "package.json",
    "package-lock.json",
    ...root.workspaces.map((workspace) => `${workspace}/package.json`),
  );
  git("commit", "-m", `chore(release): cut ${version}`);
  git("tag", "-a", tag, "-m", `Mixer ${version}`);
}
appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
console.log(`Desktop release ${tag} prepared from ${source}`);
