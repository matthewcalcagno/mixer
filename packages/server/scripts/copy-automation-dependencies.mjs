import { cp, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../plugins/package.json", import.meta.url));
const destination = fileURLToPath(
  new URL("../dist/server/builtin-plugins/automations/node_modules", import.meta.url),
);

// Electron's plugin compiler reads this directory outside the app archive.
await mkdir(destination, { recursive: true });
for (const name of ["cron-parser", "luxon", "yaml"]) {
  const manifest = await realpath(require.resolve(`${name}/package.json`));
  await cp(dirname(manifest), join(destination, name), { recursive: true });
}

await cp(dirname(dirname(await realpath(require.resolve("re2js")))), join(destination, "re2js"), {
  recursive: true,
});
