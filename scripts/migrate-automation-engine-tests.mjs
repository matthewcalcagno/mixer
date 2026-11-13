import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// These tested the removed native executor, not the imported engine's contract. Their replacement
// coverage lives in upstream core/trigger-reliability, core/scripted-actions, extension-webhooks,
// extension-jira, and extension-github tests, plus Mixer's embedded-engine integration test.
const replaced = new Set([
  "Automations setup fields preserve existing configuration and keep credentials as unresolved references",
  "Automations config.json drives real shell values, deadlines, fail-closed reloads, and delivery receipts beyond retention",
  "Automations run deadlines interrupt the provider turn rather than detaching its parent relationship",
  "Automations honors concurrency and queue bounds while serializing Jira issue resources without blocking unrelated work",
  "Automations audits concurrent Safe Actions and reconciles a lost merge acknowledgement without retrying the mutation",
  "Automations routes authenticated webhooks, polls Jira, and imports RoboPlane idempotently",
]);
const file = fileURLToPath(
  new URL("../packages/server/src/server/plugins/builtin/index.test.ts", import.meta.url),
);
let text = readFileSync(file, "utf8");
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const removals = [];
for (const statement of source.statements) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
  const call = statement.expression;
  const title = call.arguments[0];
  if (
    ts.isIdentifier(call.expression) &&
    call.expression.text === "test" &&
    title &&
    ts.isStringLiteral(title) &&
    replaced.has(title.text)
  )
    removals.push([statement.getStart(source), statement.getEnd()]);
}
for (const [start, end] of removals.toReversed()) text = text.slice(0, start) + text.slice(end);
if (removals.length) writeFileSync(file, text);
console.log(
  `Replaced ${removals.length} obsolete native-executor tests with the imported engine suites.`,
);
