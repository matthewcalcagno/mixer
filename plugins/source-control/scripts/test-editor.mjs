import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const preview = spawn(process.execPath, ["scripts/editor-preview.mjs"], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
const session = `source-control-editor-test-${process.pid}`;
function browser(...args) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}
function evaluate(code) {
  return JSON.parse(browser("--json", "eval", code)).data.result;
}
try {
  const [output] = await once(preview.stdout, "data");
  const url = output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url, "Preview must start on a loopback port");
  browser("open", url);
  browser("wait", "--fn", "window.editorEvents.some(event => event.type === 'mounted')");
  const rendered = evaluate(
    `(() => { const doc = document.querySelector('iframe').contentDocument; return {panes: Array.from(doc.querySelectorAll('.monaco-diff-editor .editor')).filter(e => e.getBoundingClientRect().width > 100).length, syntax: new Set(Array.from(doc.querySelectorAll('.view-line span')).map(e => e.className)).size, additions: doc.querySelectorAll('.line-insert, .char-insert').length, deletions: doc.querySelectorAll('.line-delete, .char-delete').length, title: document.title}; })()`,
  );
  assert.equal(
    rendered.panes,
    process.env.NEW_FILE === "1" ? 1 : 2,
    "New files should use one column and modified files should use side-by-side columns",
  );
  assert.ok(rendered.syntax > 3, "Syntax highlighting should contain distinct token classes");
  const importColor = evaluate(
    `(() => { const doc = document.querySelector('iframe').contentDocument; const token = Array.from(doc.querySelectorAll('.view-line span')).find(span => span.textContent === 'import'); return token && getComputedStyle(token).color; })()`,
  );
  assert.equal(
    importColor,
    "rgb(197, 134, 192)",
    "Diff imports must use the same TextMate Dark+ keyword color as the file editor",
  );
  assert.ok(rendered.additions > 0, "Added content should be highlighted");
  if (process.env.NEW_FILE === "1") {
    assert.equal(
      rendered.deletions,
      0,
      "A new file must not render a deleted blank line or red margin",
    );
  } else {
    assert.ok(rendered.deletions > 0, "Deleted content should be highlighted");
  }
  assert.equal(rendered.title, "price.tsx (Working Tree)");
  const colors = evaluate(
    `(() => { const doc = document.querySelector('iframe').contentDocument; const style = getComputedStyle(doc.querySelector('.monaco-editor')); return Object.fromEntries(['insertedLineBackground', 'removedLineBackground', 'insertedTextBackground', 'removedTextBackground'].map(key => [key, style.getPropertyValue('--vscode-diffEditor-' + key).trim()])); })()`,
  );
  assert.deepEqual(
    colors,
    {
      insertedLineBackground: "rgba(155, 185, 85, 0.2)",
      removedLineBackground: "rgba(255, 0, 0, 0.2)",
      insertedTextBackground: "rgba(40, 167, 69, 0.19)",
      removedTextBackground: "rgba(215, 58, 73, 0.19)",
    },
    "Diff text should use the GitHub Dark Turbo overrides over VS Code's line backgrounds",
  );
  const paintedHighlights = evaluate(
    `(() => { const doc = document.querySelector('iframe').contentDocument; return Object.fromEntries(['.line-insert', '.char-insert', '.gutter-insert', '.line-delete', '.char-delete', '.gutter-delete'].map(selector => [selector, [...new Set(Array.from(doc.querySelectorAll(selector)).map(node => getComputedStyle(node).backgroundColor))]])); })()`,
  );
  assert.deepEqual(
    paintedHighlights,
    {
      ".line-insert": ["rgba(155, 185, 85, 0.2)"],
      ".char-insert": ["rgba(40, 167, 69, 0.19)"],
      ".gutter-insert": ["rgba(0, 0, 0, 0)"],
      ".line-delete": process.env.NEW_FILE === "1" ? [] : ["rgba(255, 0, 0, 0.2)"],
      ".char-delete": process.env.NEW_FILE === "1" ? [] : ["rgba(215, 58, 73, 0.19)"],
      ".gutter-delete": ["rgba(0, 0, 0, 0)"],
    },
    "Rendered highlight layers and uncolored gutters must match the reference theme",
  );
  const point = evaluate(
    `(() => { const frame = document.querySelector('iframe'); const outer = frame.getBoundingClientRect(); const token = frame.contentDocument.querySelector('.editor.modified .view-line span').getBoundingClientRect(); return {x: outer.left + token.left + 3, y: outer.top + token.top + 3}; })()`,
  );
  browser("mouse", "move", String(point.x), String(point.y));
  browser("mouse", "down");
  browser("mouse", "up");
  browser("wait", "--fn", "window.editorEvents.some(event => event.type === 'pin')");
  assert.equal(
    evaluate("window.editorEvents.filter(event => event.type === 'pin').length"),
    1,
    "Clicking editor content must request Keep Open",
  );
  const inputs = [...browser("snapshot", "-i").matchAll(/textbox \[ref=(e\d+)\]/g)];
  assert.ok(inputs.length >= 1);
  browser("focus", `@${inputs.at(-1)[1]}`);
  browser("keyboard", "type", "// verified edit\n");
  browser("press", process.platform === "darwin" ? "Meta+s" : "Control+s");
  browser("wait", "--fn", "!!window.lastSave");
  const save = evaluate("window.lastSave");
  assert.ok(save.content.includes("// verified edit"));
  assert.equal(save.revision, "fixture-revision");
  assert.equal(
    evaluate("window.editorEvents.filter(event => event.type === 'pin').length"),
    1,
    "Editing must request Keep Open exactly once",
  );
  console.log(
    "PASS: real Monaco iframe renders the expected diff columns and colors, accepts edits, and dispatches keyboard Save with the displayed revision.",
  );
} finally {
  try {
    browser("close");
  } finally {
    preview.kill();
  }
}
