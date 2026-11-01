import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("material-icon-theme/package.json"));
const manifest = JSON.parse(await readFile(resolve(root, "dist/material-icons.json"), "utf8"));
const icons = {};
for (const [name, definition] of Object.entries(manifest.iconDefinitions)) {
  icons[name] = await readFile(resolve(root, "dist", definition.iconPath), "utf8");
}
const { iconDefinitions: _iconDefinitions, ...associations } = manifest;
const languageFileExtensions = {};
const languageFileNames = {};
// Monaco uses these short IDs where the icon theme uses VS Code's IDs.
const languageAliases = { shell: "shellscript", coffee: "coffeescript" };
const monacoRoot = dirname(require.resolve("monaco-editor/package.json"));
const languagesRoot = resolve(monacoRoot, "esm/vs/basic-languages");
for (const directory of await readdir(languagesRoot, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const filename = resolve(languagesRoot, directory.name, `${directory.name}.contribution.js`);
  const source = ts.createSourceFile(
    filename,
    await readFile(filename, "utf8"),
    ts.ScriptTarget.Latest,
  );
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "registerLanguage" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const fields = {};
      for (const property of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = property.name.getText(source);
        if (ts.isStringLiteral(property.initializer)) fields[key] = property.initializer.text;
        if (ts.isArrayLiteralExpression(property.initializer)) {
          fields[key] = property.initializer.elements
            .filter(ts.isStringLiteral)
            .map((element) => element.text);
        }
      }
      const icon = manifest.languageIds[languageAliases[fields.id] ?? fields.id];
      if (icon) {
        for (const extension of fields.extensions ?? []) {
          languageFileExtensions[extension.replace(/^\./, "").toLowerCase()] = icon;
        }
        for (const name of fields.filenames ?? []) {
          languageFileNames[name.toLowerCase()] = icon;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const output = new URL(
  "../packages/app/src/components/material-file-icons.generated.json",
  import.meta.url,
);
await writeFile(
  output,
  JSON.stringify({ ...associations, languageFileExtensions, languageFileNames, icons }, null, 2) +
    "\n",
);
await writeFile(
  new URL("../packages/app/src/components/material-file-icons.LICENSE", import.meta.url),
  await readFile(resolve(root, "LICENSE")),
);
