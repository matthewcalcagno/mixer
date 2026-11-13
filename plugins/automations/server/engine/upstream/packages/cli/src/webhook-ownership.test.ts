import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const packages = fileURLToPath(new URL("../../", import.meta.url));
function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts") ? [file] : [];
  });
}

it("keeps HTTP server creation exclusively in the bundled webhook host", () => {
  const files = fs.readdirSync(packages).filter((name) => name.startsWith("extension-")).flatMap((name) => sources(path.join(packages, name, "src")));
  const servers: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const namespaces = new Set<string>();
    const factories = new Set<string>();
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
        || !/^(node:)?(http|https|http2)$/.test(node.moduleSpecifier.text)) continue;
      if (node.importClause?.name) namespaces.add(node.importClause.name.text);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const imported of bindings.elements) {
        if (["createServer", "createSecureServer"].includes(imported.propertyName?.text ?? imported.name.text)) factories.add(imported.name.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if ((ts.isIdentifier(callee) && factories.has(callee.text))
          || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            && namespaces.has(callee.expression.text) && ["createServer", "createSecureServer"].includes(callee.name.text))) {
          servers.push(path.relative(packages, file).split(path.sep).join("/"));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(servers).toEqual(["extension-webhooks/src/index.ts"]);
});
