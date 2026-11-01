// Retire native stream rendering while retaining the desktop half of shared tests.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../packages/app/src/agent-stream");
const nativePlatforms = new Set(["ios", "android", "native"]);
function contains(node, predicate) {
  if (predicate(node)) return true;
  return Boolean(ts.forEachChild(node, (child) => contains(child, predicate)));
}
function isNativeConfig(node) {
  return contains(
    node,
    (child) =>
      ts.isPropertyAssignment(child) &&
      child.name.getText() === "platform" &&
      ts.isStringLiteral(child.initializer) &&
      nativePlatforms.has(child.initializer.text),
  );
}
function trimTest(node) {
  const blocked = new Set();
  let grew;
  do {
    grew = false;
    contains(node, (child) => {
      if (
        ts.isVariableDeclaration(child) &&
        ts.isIdentifier(child.name) &&
        child.initializer &&
        (isNativeConfig(child.initializer) ||
          contains(child.initializer, (part) => ts.isIdentifier(part) && blocked.has(part.text))) &&
        !blocked.has(child.name.text)
      ) {
        blocked.add(child.name.text);
        grew = true;
      }
      return false;
    });
  } while (grew);
  if (!blocked.size && !isNativeConfig(node)) return node;
  const result = ts.transform(node, [
    (context) => {
      const visit = (child) => {
        if (ts.isVariableStatement(child)) {
          const remaining = child.declarationList.declarations.filter(
            (declaration) =>
              !ts.isIdentifier(declaration.name) || !blocked.has(declaration.name.text),
          );
          if (!remaining.length) return undefined;
          child = ts.factory.updateVariableStatement(
            child,
            child.modifiers,
            ts.factory.updateVariableDeclarationList(child.declarationList, remaining),
          );
        }
        if (
          ts.isExpressionStatement(child) &&
          (isNativeConfig(child.expression) ||
            contains(child.expression, (part) => ts.isIdentifier(part) && blocked.has(part.text)))
        )
          return undefined;
        return ts.visitEachChild(child, visit, context);
      };
      return (child) => ts.visitNode(child, visit);
    },
  ]);
  const updated = result.transformed[0];
  const hasAssertions = contains(
    updated,
    (child) =>
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "expect",
  );
  result.dispose();
  return hasAssertions ? updated : undefined;
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!/resolveStreamRenderStrategy/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const result = ts.transform(source, [
      (context) => {
        const visit = (node) => {
          if (
            file.includes(".test.") &&
            ts.isExpressionStatement(node) &&
            ts.isCallExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            ["it", "test"].includes(node.expression.expression.text)
          ) {
            const trimmed = trimTest(node.expression);
            if (!trimmed) return undefined;
            node = ts.factory.updateExpressionStatement(node, trimmed);
          }
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "resolveStreamRenderStrategy" &&
            ts.isObjectLiteralExpression(node.arguments[0])
          ) {
            node = ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
              ts.factory.updateObjectLiteralExpression(
                node.arguments[0],
                node.arguments[0].properties.filter(
                  (property) => property.name?.getText(source) !== "platform",
                ),
              ),
            ]);
          }
          if (
            file.includes(".test.") &&
            ts.isArrayLiteralExpression(node) &&
            node.elements.some((element) => ts.isStringLiteral(element) && element.text === "web")
          ) {
            node = ts.factory.updateArrayLiteralExpression(
              node,
              node.elements.filter(
                (element) => !ts.isStringLiteral(element) || !nativePlatforms.has(element.text),
              ),
            );
          }
          return ts.visitEachChild(node, visit, context);
        };
        return (node) => ts.visitNode(node, visit);
      },
    ]);
    fs.writeFileSync(file, ts.createPrinter().printFile(result.transformed[0]));
    result.dispose();
    console.log(path.relative(root, file));
  }
}
walk(root);
