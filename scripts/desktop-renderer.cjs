// Fold obsolete native-platform branches using the same web platform Electron runs.
// Review with a source backup before running. Compact-window layout is not a platform gate.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../packages/app/src");
// eslint-disable-next-line complexity -- Deliberately limited constant-expression evaluator.
function value(node) {
  if (ts.isParenthesizedExpression(node)) return value(node.expression);
  if (ts.isIdentifier(node) && node.text === "isWeb") return true;
  if (ts.isIdentifier(node) && node.text === "isNative") return false;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Platform" &&
    node.name.text === "OS"
  )
    return "web";
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = value(node.operand);
    if (operand !== undefined) return !operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = value(node.left),
      right = value(node.right);
    if (left === undefined || right === undefined) return undefined;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return left !== right;
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return left && right;
      case ts.SyntaxKind.BarBarToken:
        return left || right;
    }
  }
}
function exits(node) {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node))
    return node.statements.length > 0 && exits(node.statements[node.statements.length - 1]);
  return (
    ts.isIfStatement(node) &&
    node.elseStatement &&
    exits(node.thenStatement) &&
    exits(node.elseStatement)
  );
}
let changedPass = false;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!/\.[jt]sx?$/.test(file) || /\.(test|spec)\./.test(file) || /\.gen\.|\.d\.ts$/.test(file))
      continue;
    const original = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
    let changed = false;
    const result = ts.transform(source, [
      (context) => {
        // eslint-disable-next-line complexity -- Each case removes one obsolete platform construct.
        const visit = (node) => {
          if (ts.isIfStatement(node)) {
            const condition = value(node.expression);
            if (typeof condition === "boolean") {
              changed = true;
              return ts.visitNode(
                condition
                  ? node.thenStatement
                  : (node.elseStatement ?? ts.factory.createEmptyStatement()),
                visit,
              );
            }
          }
          if (ts.isConditionalExpression(node)) {
            const condition = value(node.condition);
            if (typeof condition === "boolean") {
              changed = true;
              return ts.visitNode(condition ? node.whenTrue : node.whenFalse, visit);
            }
          }
          if (ts.isBinaryExpression(node)) {
            const left = value(node.left);
            if (
              typeof left === "boolean" &&
              (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
            ) {
              changed = true;
              const useRight =
                node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? left : !left;
              if (useRight) return ts.visitNode(node.right, visit);
              return left ? ts.factory.createTrue() : ts.factory.createFalse();
            }
          }
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Platform" &&
            node.expression.name.text === "select" &&
            ts.isObjectLiteralExpression(node.arguments[0])
          ) {
            const properties = node.arguments[0].properties;
            const selected =
              properties.find(
                (p) =>
                  ts.isPropertyAssignment(p) &&
                  p.name.getText(source).replace(/["']/g, "") === "web",
              ) ??
              properties.find(
                (p) =>
                  ts.isPropertyAssignment(p) &&
                  p.name.getText(source).replace(/["']/g, "") === "default",
              );
            if (selected) {
              changed = true;
              return ts.visitNode(selected.initializer, visit);
            }
          }
          const updated = ts.visitEachChild(node, visit, context);
          if (ts.isBlock(updated)) {
            const statements = [];
            for (const statement of updated.statements) {
              if (ts.isEmptyStatement(statement)) {
                changed = true;
                continue;
              }
              statements.push(statement);
              if (exits(statement)) break;
            }
            if (statements.length !== updated.statements.length) {
              changed = true;
              return ts.factory.updateBlock(updated, statements);
            }
          }
          return updated;
        };
        return (node) => ts.visitNode(node, visit);
      },
    ]);
    if (changed) {
      changedPass = true;
      fs.writeFileSync(file, ts.createPrinter().printFile(result.transformed[0]));
      console.log(path.relative(root, file));
    }
    result.dispose();
  }
}
do {
  changedPass = false;
  walk(root);
} while (changedPass);
