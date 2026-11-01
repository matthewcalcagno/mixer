// Consume oxlint's JSON diagnostics after removing native branches.
const fs = require("node:fs");
const ts = require("typescript");
const input = fs.readFileSync(process.argv[2], "utf8");
const { diagnostics } = JSON.parse(input.slice(input.indexOf("{")));
const files = new Map();
const declarations = new Map();
const dependencies = new Map();
for (const diagnostic of diagnostics) {
  if (!/^packages\/(app|server|website)\/src\//.test(diagnostic.filename)) continue;
  const dependency = /unnecessary dependency: (\w+)/.exec(diagnostic.message);
  if (dependency) {
    if (!dependencies.has(diagnostic.filename)) dependencies.set(diagnostic.filename, []);
    dependencies
      .get(diagnostic.filename)
      .push({ name: dependency[1], offset: diagnostic.labels[0].span.offset });
    if (!files.has(diagnostic.filename)) files.set(diagnostic.filename, new Set());
  }
  const unused = /^(?:Variable|Function) '([^']+)'/.exec(diagnostic.message);
  if (unused) {
    if (!declarations.has(diagnostic.filename)) declarations.set(diagnostic.filename, new Set());
    declarations.get(diagnostic.filename).add(unused[1]);
    if (!files.has(diagnostic.filename)) files.set(diagnostic.filename, new Set());
  }
  const match = /^(?:Identifier|Type) '([^']+)' is imported but never used/.exec(
    diagnostic.message,
  );
  if (!match) continue;
  if (!files.has(diagnostic.filename)) files.set(diagnostic.filename, new Set());
  files.get(diagnostic.filename).add(match[1]);
}
for (const [file, names] of files) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) return [statement];
    const clause = statement.importClause;
    const name = clause.name && !names.has(clause.name.text) ? clause.name : undefined;
    let bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const elements = bindings.elements.filter((element) => !names.has(element.name.text));
      bindings = elements.length ? ts.factory.updateNamedImports(bindings, elements) : undefined;
    } else if (bindings && names.has(bindings.name.text)) bindings = undefined;
    if (!name && !bindings) return [];
    return [
      ts.factory.updateImportDeclaration(
        statement,
        statement.modifiers,
        ts.factory.updateImportClause(clause, clause.isTypeOnly, name, bindings),
        statement.moduleSpecifier,
        statement.attributes,
      ),
    ];
  });
  const unused = declarations.get(file) ?? new Set();
  const deps = dependencies.get(file) ?? [];
  const result = ts.transform(ts.factory.updateSourceFile(source, statements), [
    (context) => {
      const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name && unused.has(node.name.text))
          return undefined;
        if (ts.isVariableStatement(node)) {
          const remaining = node.declarationList.declarations.filter(
            (declaration) =>
              !ts.isIdentifier(declaration.name) || !unused.has(declaration.name.text),
          );
          if (!remaining.length) return undefined;
          node = ts.factory.updateVariableStatement(
            node,
            node.modifiers,
            ts.factory.updateVariableDeclarationList(node.declarationList, remaining),
          );
        }
        if (ts.isArrayBindingPattern(node)) {
          const elements = node.elements.map((element) =>
            ts.isBindingElement(element) &&
            ts.isIdentifier(element.name) &&
            unused.has(element.name.text)
              ? ts.factory.createOmittedExpression()
              : element,
          );
          while (elements.length && ts.isOmittedExpression(elements[elements.length - 1]))
            elements.pop();
          return ts.factory.updateArrayBindingPattern(node, elements);
        }
        if (
          ts.isCallExpression(node) &&
          node.arguments.length === 2 &&
          ts.isArrayLiteralExpression(node.arguments[1])
        ) {
          const array = node.arguments[1];
          const dependencyNames = new Set(
            deps
              .filter((dep) => dep.offset >= array.pos && dep.offset < array.end)
              .map((dep) => dep.name),
          );
          if (dependencyNames.size)
            node = ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
              node.arguments[0],
              ts.factory.updateArrayLiteralExpression(
                array,
                array.elements.filter(
                  (element) => !ts.isIdentifier(element) || !dependencyNames.has(element.text),
                ),
              ),
            ]);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit);
    },
  ]);
  fs.writeFileSync(file, ts.createPrinter().printFile(result.transformed[0]));
  result.dispose();
  console.log(file);
}
