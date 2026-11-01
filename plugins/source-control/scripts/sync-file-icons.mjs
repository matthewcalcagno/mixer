import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/sync-file-icons.mjs <mixer-checkout>");
const vendor = new URL("../client/vendor/", import.meta.url);
for (const name of ["material-file-icons.ts", "material-file-icons.generated.json"]) {
  const contents = await readFile(resolve(checkout, "packages/app/src/components", name), "utf8");
  const notice = name.endsWith(".ts")
    ? "// Vendored from mixer/mixer. See THIRD_PARTY_NOTICES.md.\n"
    : "";
  await writeFile(fileURLToPath(new URL(name, vendor)), notice + contents);
}
