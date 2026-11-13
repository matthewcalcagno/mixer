// Emit a patch by default. --write applies it; --check finds stale CLI references.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const commands = { run: ["automations", "run"], replay: ["automations", "rerun"], ps: ["automations", "list"],
  plan: ["automations", "files"], validate: ["automations", "validate"], add: ["automations", "create"],
  inspect: ["automations", "inspect"], cancel: ["automations", "cancel"], reroute: ["events", "reroute"],
  event: ["events"], action: ["actions"] };

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name) ? files(file)
      : entry.isFile() && /\.(ts|md|yaml|yml|txt)$/.test(entry.name) ? [file] : [];
  });
}
function rewrite(file, text) {
  if (file.includes("/packages/cli/") && file.endsWith(".test.ts")) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const edits = [];
    const visit = (node) => {
      if (ts.isArrayLiteralExpression(node) && !node.getText(source).includes("\n")) {
        const parent = node.parent;
        const callee = ts.isCallExpression(parent) ? parent.expression : undefined;
        const name = callee && ts.isIdentifier(callee) ? callee.text : callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        const isArgs = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.name.text === "args";
        if (["cli", "invoke"].includes(name) || isArgs) {
          const first = node.elements[0];
          const head = first && ts.isStringLiteral(first) ? first.text : undefined;
          let replacement = commands[head];
          if (head === "logs" && node.elements.length > 1 && !(ts.isStringLiteral(node.elements[1]) && node.elements[1].text.startsWith("--"))) replacement = ["automations", "logs"];
          if (head === "extensions" && node.elements.length === 1) replacement = ["extensions", "list"];
          if (replacement) {
            const rest = node.elements.slice(1).map((element) => element.getText(source));
            if (head === "run") {
              const detached = rest.indexOf('"--detach"');
              if (detached >= 0) rest.splice(detached, 1);
              else if (!rest.includes('"--wait"')) rest.push('"--wait"');
            }
            if (head === "event") for (let index = 0; index < rest.length; index++) {
              if (rest[index] === '"--input"') rest[index] = '"--input-file"';
              else if (rest[index] === '"--data"') rest[index] = '"--input"';
            }
            if (head === "replay") {
              const index = rest.indexOf('"--workflow"');
              if (index >= 0) rest.splice(index, 2, ...(rest[index + 1] === '"current"' ? ['"--current"'] : []));
            }
            edits.push({ start: node.getStart(source), end: node.end, text: `[${[...replacement.map((part) => JSON.stringify(part)), ...rest].join(", ")}]` });
          } else if (head === "extensions" && node.elements[1] && ts.isStringLiteral(node.elements[1]) && node.elements[1].text === "check") {
            edits.push({ start: node.elements[1].getStart(source), end: node.elements[1].end, text: '"validate"' });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  text = text.replace(/\broboplane (run|replay|ps|plan|validate|add|inspect|cancel|reroute|event|action)(?=[\s`"'\\]|$)/g,
    (_match, command) => `mixer-automations ${commands[command].join(" ")}`);
  text = text.replace(/roboplane extensions check\b/g, "mixer-automations extensions validate");
  text = text.replace(/roboplane logs(?= (?:<|rp_|\[run\]))/g, "mixer-automations automations logs");
  if (file.endsWith(".md") || file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".txt") || file.endsWith(".test.ts")) {
    text = text.replace(/ --detach\b/g, "").replace(/--workflow current\b/g, "--current").replace(/ --workflow snapshot\b/g, "");
    text = text.replace(/^([ \t]*)--detach\s*\\$/gm, "$1\\");
  }
  return text;
}

const changed = [];
const patch = ["*** Begin Patch"];
for (const file of [...files(path.join(root, "docs")), ...files(path.join(root, "examples")), ...files(path.join(root, "packages")), path.join(root, "README.md")].sort()) {
  const before = fs.readFileSync(file, "utf8");
  const after = rewrite(file, before);
  if (before === after) continue;
  const oldLines = before.split("\n"); const newLines = after.split("\n");
  if (oldLines.length !== newLines.length) throw new Error(`Expected line-preserving edits: ${file}`);
  const relative = path.relative(root, file);
  changed.push(relative);
  if (process.argv.includes("--write")) fs.writeFileSync(file, after);
  patch.push(`*** Update File: ${file}`);
  for (let index = 0; index < oldLines.length; index++) if (oldLines[index] !== newLines[index]) {
    patch.push("@@", `-${oldLines[index]}`, `+${newLines[index]}`);
  }
}
patch.push("*** End Patch");
if (process.argv.includes("--write")) console.log(changed.join("\n"));
else if (process.argv.includes("--check")) {
  if (changed.length) { console.error(changed.join("\n")); process.exitCode = 1; }
} else console.log(patch.join("\n"));
