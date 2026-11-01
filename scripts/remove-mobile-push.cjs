// Remove the Expo push transport and migrate its internal callers in the same pass.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../packages/server/src");
const obsolete = new Set(["pushNotifications", "pushNotificationSender"]);
const serverPath = path.join(root, "server/websocket-server.ts");
const server = ts.createSourceFile(
  serverPath,
  fs.readFileSync(serverPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const serverClass = server.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name.text === "VoiceAssistantWebSocketServer",
);
const constructor = serverClass.members.find(ts.isConstructorDeclaration);
const parameterIndex = constructor.parameters.findIndex(
  (parameter) => parameter.name.getText(server) === "pushNotificationSender",
);
if (parameterIndex < 0)
  throw new Error("Push parameter already removed; do not rerun this one-shot migration.");
function nameOf(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : "";
}
function isPushTransport(text) {
  return /pushNotifications|pushNotificationSender|\.handleRegisterPushToken/.test(text);
}
function transformFile(file) {
  const original = fs.readFileSync(file, "utf8");
  if (
    !/pushNotifications|PushNotification|asPushNotifications|pushNotificationSender|push\/index/.test(
      original,
    )
  )
    return;
  const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const result = ts.transform(source, [
    (context) => {
      // eslint-disable-next-line complexity -- One-shot migration of each internal API use shape.
      const visit = (node) => {
        if (ts.isImportDeclaration(node)) {
          if (
            typeof node.moduleSpecifier.text === "string" &&
            node.moduleSpecifier.text.endsWith("/push/index.js")
          )
            return undefined;
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            const elements = bindings.elements.filter(
              (element) => element.name.text !== "asPushNotifications",
            );
            if (!elements.length && !node.importClause.name) return undefined;
            return ts.factory.updateImportDeclaration(
              node,
              node.modifiers,
              ts.factory.updateImportClause(
                node.importClause,
                node.importClause.isTypeOnly,
                node.importClause.name,
                ts.factory.updateNamedImports(bindings, elements),
              ),
              node.moduleSpecifier,
              node.attributes,
            );
          }
        }
        if (
          (ts.isPropertyDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node) ||
            ts.isBindingElement(node) ||
            ts.isParameter(node)) &&
          obsolete.has(nameOf(node))
        )
          return undefined;
        if (
          (ts.isFunctionDeclaration(node) && nameOf(node) === "asPushNotifications") ||
          (ts.isMethodDeclaration(node) && nameOf(node) === "handleRegisterPushToken") ||
          (ts.isClassDeclaration(node) && nameOf(node) === "RecordingPushNotificationSender")
        )
          return undefined;
        if (ts.isVariableStatement(node)) {
          const declarations = node.declarationList.declarations.filter(
            (declaration) => !obsolete.has(nameOf(declaration)),
          );
          if (!declarations.length) return undefined;
          node = ts.factory.updateVariableStatement(
            node,
            node.modifiers,
            ts.factory.updateVariableDeclarationList(node.declarationList, declarations),
          );
        }
        if (ts.isIfStatement(node) && node.expression.getText(source) === "plan.shouldPush")
          return undefined;
        if (ts.isExpressionStatement(node)) {
          const text = node.getText(source);
          if (
            isPushTransport(text) &&
            (text.startsWith("this.") ||
              text.startsWith("expect(") ||
              /vi\.mock\(["']\.\/push\/index\.js/.test(text))
          )
            return undefined;
          const call = node.expression;
          if (
            ts.isCallExpression(call) &&
            ts.isIdentifier(call.expression) &&
            ["it", "test"].includes(call.expression.text) &&
            ts.isStringLiteral(call.arguments[0])
          ) {
            const title = call.arguments[0].text;
            if (
              /mobile/i.test(title) ||
              (/\bpush(?:es)?\b/i.test(title) &&
                /pushNotifications|register_push_token|pushNotificationSender/.test(text))
            )
              return undefined;
          }
        }
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "VoiceAssistantWebSocketServer" &&
          node.arguments &&
          node.arguments.length > parameterIndex
        ) {
          node = ts.factory.updateNewExpression(
            node,
            node.expression,
            node.typeArguments,
            node.arguments.filter((_, index) => index !== parameterIndex),
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
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "push") walk(file);
    } else if (file.endsWith(".ts")) transformFile(file);
  }
}
walk(root);
