const fs = require("node:fs");
const path = require("node:path");

/** Fail packaging rather than ship a Search panel with no executable for its target. */
function verifyRipgrepAssets(resourcesDir, platform, arch) {
  const architectures = arch === "universal" ? ["x64", "arm64"] : [arch];
  for (const architecture of architectures) {
    const nodeArch = architecture === "armv7l" ? "arm" : architecture;
    const name = `@vscode/ripgrep-${platform}-${nodeArch}`;
    const binary = platform === "win32" ? "rg.exe" : "rg";
    const filename = path.join(
      resourcesDir,
      "app.asar.unpacked",
      "node_modules",
      name,
      "bin",
      binary,
    );
    if (!fs.existsSync(filename))
      throw new Error(
        `Missing Search engine ${filename}. Install optional dependency ${name} for the packaging target before building.`,
      );
  }
}
module.exports = { verifyRipgrepAssets };
