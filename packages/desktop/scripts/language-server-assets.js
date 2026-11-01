const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function copyLanguageServerAssets(resourcesDir, packageRoots) {
  for (const [name, source] of Object.entries(packageRoots)) {
    const destination = path.join(resourcesDir, "language-servers", "node_modules", name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, dereference: true });
  }
}

function installLanguageServerAssets(resourcesDir) {
  const serverRequire = createRequire(require.resolve("@mixer/server/daemon-control"));
  const packages = ["typescript", "typescript-language-server", "pyright"];
  const roots = Object.fromEntries(
    packages.map((name) => [name, path.dirname(serverRequire.resolve(`${name}/package.json`))]),
  );
  copyLanguageServerAssets(resourcesDir, roots);
}

module.exports = { copyLanguageServerAssets, installLanguageServerAssets };
