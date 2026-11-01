import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export function languageServerPackageRoot(
  name: string,
  moduleUrl: string | URL = import.meta.url,
): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const archive = directory.indexOf(`${path.sep}app.asar${path.sep}`);
  if (archive !== -1)
    return path.join(directory.slice(0, archive), "language-servers", "node_modules", name);
  return path.dirname(require.resolve(`${name}/package.json`));
}
