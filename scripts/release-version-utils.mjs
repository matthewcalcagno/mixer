const versionPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/;
const sourceTagPattern =
  /^(?:(?:desktop(?:-(?:windows|linux|macos))?|android)-)?v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function parseReleaseVersion(version) {
  const trimmed = version.trim();
  const match = trimmed.match(versionPattern);
  if (!match?.groups) {
    throw new Error(
      `Unsupported release version "${version}". Expected semver like 0.1.41 or 0.1.41-beta.1.`,
    );
  }

  const major = Number.parseInt(match.groups.major, 10);
  const minor = Number.parseInt(match.groups.minor, 10);
  const patch = Number.parseInt(match.groups.patch, 10);
  const prerelease = match.groups.prerelease ?? null;
  const betaMatch = prerelease?.match(/^beta\.(?<beta>\d+)$/) ?? null;
  const betaNumber = betaMatch?.groups?.beta ? Number.parseInt(betaMatch.groups.beta, 10) : null;

  if (prerelease !== null && betaNumber === null) {
    throw new Error(
      `Unsupported release version "${version}". Expected beta prerelease versions like 0.1.41-beta.1.`,
    );
  }

  assertInteger(major, "major version");
  assertInteger(minor, "minor version");
  assertInteger(patch, "patch version");
  if (betaNumber !== null) {
    assertInteger(betaNumber, "beta number");
  }

  return {
    version: trimmed,
    major,
    minor,
    patch,
    prerelease,
    baseVersion: `${major}.${minor}.${patch}`,
    isPrerelease: prerelease !== null,
    isBeta: betaNumber !== null,
    betaNumber,
  };
}

export function formatReleaseVersion({ major, minor, patch, prerelease = null }) {
  assertInteger(major, "major version");
  assertInteger(minor, "minor version");
  assertInteger(patch, "patch version");
  return prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
}

export function normalizeReleaseTag(rawTag) {
  const trimmed = rawTag.trim().replace(/^refs\/tags\//, "");
  const match = trimmed.match(sourceTagPattern);
  if (!match?.groups?.version) {
    throw new Error(
      `Unsupported release tag "${rawTag}". Expected vX.Y.Z, vX.Y.Z-beta.N, desktop-v..., or android-v...`,
    );
  }
  return `v${match.groups.version}`;
}

export function getReleaseInfoFromSourceTag(sourceTag) {
  const releaseTag = normalizeReleaseTag(sourceTag);
  const parsed = parseReleaseVersion(releaseTag.slice(1));
  return {
    sourceTag,
    releaseTag,
    version: parsed.version,
    baseVersion: parsed.baseVersion,
    prerelease: parsed.prerelease,
    isPrerelease: parsed.isPrerelease,
    isBeta: parsed.isBeta,
    betaNumber: parsed.betaNumber,
    releaseType: parsed.isPrerelease ? "prerelease" : "release",
    releaseChannel: parsed.isBeta ? "beta" : "latest",
    isSmokeTag: sourceTag.includes("gha-smoke"),
  };
}

export function computeNextReleaseVersion(currentVersion, mode) {
  const parsed = parseReleaseVersion(currentVersion);

  if (mode === "patch" || mode === "minor" || mode === "major") {
    if (parsed.isPrerelease) {
      throw new Error(
        `Cannot cut a stable ${mode} release from prerelease version ${currentVersion}. Promote it first.`,
      );
    }
    if (mode === "patch") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
      });
    }
    if (mode === "minor") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 0,
      });
    }
    return formatReleaseVersion({
      major: parsed.major + 1,
      minor: 0,
      patch: 0,
    });
  }

  if (mode === "beta-patch" || mode === "beta-minor" || mode === "beta-major") {
    if (parsed.isPrerelease) {
      throw new Error(
        `Cannot start a new beta line from prerelease version ${currentVersion}. Use beta-next or promote.`,
      );
    }
    if (mode === "beta-patch") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
        prerelease: "beta.1",
      });
    }
    if (mode === "beta-minor") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 0,
        prerelease: "beta.1",
      });
    }
    return formatReleaseVersion({
      major: parsed.major + 1,
      minor: 0,
      patch: 0,
      prerelease: "beta.1",
    });
  }

  if (mode === "beta-next") {
    if (!parsed.isBeta || parsed.betaNumber === null) {
      throw new Error(
        `Cannot advance beta number from ${currentVersion}. Expected a version like 0.1.41-beta.1.`,
      );
    }
    return formatReleaseVersion({
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: `beta.${parsed.betaNumber + 1}`,
    });
  }

  if (mode === "promote") {
    if (!parsed.isBeta) {
      throw new Error(
        `Cannot promote ${currentVersion}. Expected a beta version like 0.1.41-beta.1.`,
      );
    }
    return parsed.baseVersion;
  }

  throw new Error(`Unsupported release mode "${mode}".`);
}

export const DESKTOP_RELEASE_TAG_PREFIX = "desktop-v";

export function getDesktopReleaseTag(version) {
  return `${DESKTOP_RELEASE_TAG_PREFIX}${parseReleaseVersion(version).version}`;
}

export function getDesktopReleasePlan(sourceTag, platform) {
  const info = getReleaseInfoFromSourceTag(sourceTag);
  if (sourceTag.startsWith("android-")) {
    throw new Error(`Not a desktop release tag: ${sourceTag}`);
  }
  const supported = ["macos", "linux", "windows"];
  if (platform && platform !== "all" && !supported.includes(platform)) {
    throw new Error(`Unknown desktop release platform: ${platform}`);
  }
  const tagPlatform = sourceTag.match(/^desktop-(macos|linux|windows)-v/)?.[1];
  const platforms = platform === "all" ? supported : [platform || tagPlatform || "macos"];
  const suffixes = { macos: "-mac", linux: "-linux", windows: "" };
  return {
    platforms,
    manifestNames: platforms.map((name) => `${info.releaseChannel}${suffixes[name]}.yml`),
  };
}

export function getMergedReleaseMode(labels) {
  return ["major", "minor", "patch"].find((mode) => labels.includes(`release:${mode}`)) || "patch";
}

export function getMergedReleasePlan({ currentVersion, tags, labels }) {
  const stable = [currentVersion, ...tags.map((tag) => tag.replace(/^desktop-v/, ""))]
    .map(parseReleaseVersion)
    .filter((version) => !version.isPrerelease)
    .sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
  if (!stable.length) throw new Error("Merge releases require an existing stable version");
  const mode = getMergedReleaseMode(labels);
  const version = computeNextReleaseVersion(stable[0].version, mode);
  return { mode, version, tag: getDesktopReleaseTag(version) };
}
