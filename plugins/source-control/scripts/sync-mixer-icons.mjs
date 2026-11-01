import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/sync-mixer-icons.mjs /path/to/mixer-checkout");
const destination = new URL("../client/vendor/", import.meta.url);
const check = process.argv.includes("--check");
async function sync(url, contents) {
  if (check) {
    const current = await readFile(url, "utf8");
    if (current !== contents) throw new Error(`Icon snapshot differs: ${url.pathname}`);
  } else {
    await writeFile(url, contents);
  }
}
await mkdir(destination, { recursive: true });
for (const name of ["material-file-icons.ts", "file-icon-svg.ts"]) {
  const source = await readFile(resolve(checkout, "packages/app/src/components", name), "utf8");
  const contents = source
    .replaceAll('"@/components/material-file-icons"', '"./material-file-icons.js"')
    .replaceAll('"@/utils/color"', '"./color.js"')
    .replace(
      'from "./material-file-icons.generated.json";',
      'from "./material-file-icons.generated.json" with { type: "json" };',
    );
  await sync(
    new URL(name, destination),
    `// Vendored from mixer/mixer. See THIRD_PARTY_NOTICES.md.\n${contents}`,
  );
}
await sync(
  new URL("color.ts", destination),
  `// Vendored from mixer/mixer. See THIRD_PARTY_NOTICES.md.\n${await readFile(resolve(checkout, "packages/app/src/utils/color.ts"), "utf8")}`,
);
await sync(
  new URL("../../MIXER-LICENSE", destination),
  await readFile(resolve(checkout, "LICENSE"), "utf8"),
);
for (const name of ["material-file-icons.generated.json", "material-file-icons.LICENSE"]) {
  await sync(
    new URL(name, destination),
    await readFile(resolve(checkout, "packages/app/src/components", name), "utf8"),
  );
}
