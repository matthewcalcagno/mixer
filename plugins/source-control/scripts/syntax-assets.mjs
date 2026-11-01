import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";

/** Keep the offline iframe small: decompress only the requested grammar, not the whole registry. */
export async function compressedSyntaxRegistry() {
  const packed = {};
  const aliases = {};
  const grammarNames = {};
  const grammarSources = new Map();
  for (const language of bundledLanguagesInfo) {
    const module = await bundledLanguages[language.id]();
    const grammars = Array.isArray(module) ? module : module.default;
    if (!Array.isArray(grammars)) throw new Error(`Missing TextMate grammars for ${language.id}`);
    grammarNames[language.id] = [];
    for (const grammar of grammars) {
      const source = JSON.stringify(grammar);
      const previous = grammarSources.get(grammar.name);
      if (previous && previous !== source)
        throw new Error(`Conflicting TextMate grammar ${grammar.name}`);
      if (!previous) {
        grammarSources.set(grammar.name, source);
        packed[grammar.name] = gzipSync(source, { level: 9 }).toString("base64");
      }
      grammarNames[language.id].push(grammar.name);
    }
    for (const alias of language.aliases ?? []) aliases[alias] = language.id;
  }
  return `
export const bundledLanguagesInfo = ${JSON.stringify(bundledLanguagesInfo)};
const packed = ${JSON.stringify(packed)};
const aliases = ${JSON.stringify(aliases)};
const grammarNames = ${JSON.stringify(grammarNames)};
const loaded = new Map();
function loadGrammar(id) {
  if (!loaded.has(id)) {
    const bytes = Uint8Array.from(atob(packed[id]), character => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    loaded.set(id, new Response(stream).text().then(text => JSON.parse(text)));
  }
  return loaded.get(id);
}
export const bundledLanguages = {};
for (const id of Object.keys(grammarNames)) bundledLanguages[id] = () => Promise.all(grammarNames[id].map(loadGrammar));
for (const [alias, id] of Object.entries(aliases)) bundledLanguages[alias] = bundledLanguages[id];
`;
}

/** Read the same filename/extension registrations used by the normal Monaco editor. */
export async function monacoLanguageRegistrations() {
  const require = createRequire(import.meta.url);
  const root = join(
    dirname(require.resolve("monaco-editor/package.json")),
    "esm/vs/basic-languages",
  );
  const languages = [];
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const filename = join(root, directory.name, `${directory.name}.contribution.js`);
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
          if (ts.isArrayLiteralExpression(property.initializer))
            fields[key] = property.initializer.elements
              .filter(ts.isStringLiteral)
              .map((element) => element.text);
        }
        if (fields.id) languages.push(fields);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return languages;
}
