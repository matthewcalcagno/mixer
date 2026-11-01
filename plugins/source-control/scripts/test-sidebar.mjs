import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const preview = spawn(process.execPath, ["scripts/sidebar-preview.mjs"], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
const session = `source-control-sidebar-test-${process.pid}`;
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
  assert.ok(url);
  browser("open", url);
  browser("wait", "--text", "Staged Changes");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '1'",
  );
  evaluate(
    "window.setSourceControlFiles([{path:'src/price.tsx',index:'M',worktree:'M',head:'M'},{path:'new.ts',index:'?',worktree:'?',head:'?'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '2'",
  );
  assert.equal(
    evaluate(
      "document.querySelector('[data-testid=source-control-change-badge]').getAttribute('aria-label')",
    ),
    "2 uncommitted files",
  );
  evaluate(
    "window.setSourceControlFiles(Array.from({length:500},(_,i)=>({path:'src/file-'+i+'.ts',index:'M',worktree:' ',head:'M'})))",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", '[aria-label="Open staged diff for src/file-499.ts"]');
  browser("find", "label", "Commit message", "fill", "fix:");
  const rendersBeforeTyping = evaluate("window.fixtureIconRenders");
  browser("find", "label", "Commit message", "type", " keep typing with 500 staged files");
  const typingIconRenders = evaluate("window.fixtureIconRenders") - rendersBeforeTyping;
  assert.ok(
    typingIconRenders < 100,
    `Typing rerendered the resource list: ${typingIconRenders} icons`,
  );
  browser("find", "label", "Commit message", "fill", "");
  evaluate("window.resetCommitFixture()");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '1'",
  );
  const inspect = `(() => {const input=document.querySelector('[aria-label="Commit message"]');const button=document.querySelector('[aria-label="Commit staged changes"]');return {height:input.getBoundingClientRect().height,disabled:button.getAttribute('aria-disabled'),background:getComputedStyle(button).backgroundColor,text:document.body.innerText,icon:getComputedStyle(document.querySelector('[data-icon="RotateCw"]')).color};})()`;
  let state = evaluate(inspect);
  assert.equal(state.height, 32);
  assert.equal(state.disabled, "true");
  assert.ok(!state.text.includes("develop"));
  assert.ok(!state.text.includes("Remote checked"));
  assert.ok(!state.text.includes("↓0"));
  assert.equal(state.icon, "rgb(157, 165, 174)");
  evaluate(
    "window.confirm=()=>true;window.deferDiscard=true;window.setSourceControlFiles([{path:'src/price.tsx',index:' ',worktree:'M',head:'M'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '1'",
  );
  browser("wait", '[aria-label="Open working tree diff for src/price.tsx"]');
  browser("hover", '[aria-label="Open working tree diff for src/price.tsx"]');
  browser("find", "role", "button", "click", "--name", "Discard price.tsx", "--exact");
  browser("wait", "--fn", "typeof window.completeDiscard === 'function'");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]') === null",
  );
  assert.equal(
    evaluate("!!document.querySelector('[data-testid=source-control-change-badge]')"),
    false,
    "Discard must update the badge before the server responds",
  );
  assert.equal(
    evaluate(
      "!!document.querySelector('[aria-label=\"Open working tree diff for src/price.tsx\"]')",
    ),
    false,
    "Discard must remove the row before the server responds",
  );
  evaluate("window.completeDiscard()");
  browser("wait", "--fn", "!document.querySelector('[aria-busy=true]')");
  evaluate(
    "delete window.completeDiscard;window.setSourceControlFiles([{path:'src/price.tsx',index:' ',worktree:'M',head:'M'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '1'",
  );
  browser("wait", '[aria-label="Open working tree diff for src/price.tsx"]');
  browser("hover", '[aria-label="Open working tree diff for src/price.tsx"]');
  browser("find", "role", "button", "click", "--name", "Discard price.tsx", "--exact");
  browser("wait", "--fn", "typeof window.completeDiscard === 'function'");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]') === null",
  );
  assert.equal(
    evaluate("!!document.querySelector('[data-testid=source-control-change-badge]')"),
    false,
  );
  evaluate("window.rejectDiscard()");
  browser("wait", "--text", "Discard failed");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '1'",
  );
  assert.equal(
    evaluate(
      "!!document.querySelector('[aria-label=\"Open working tree diff for src/price.tsx\"]')",
    ),
    true,
    "Failed discard must restore the row",
  );
  evaluate("window.resetCommitFixture()");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Staged Changes");
  browser("find", "label", "Commit message", "fill", "fix: price");
  const focusRing = evaluate(
    `(() => {const style=getComputedStyle(document.querySelector('[aria-label="Commit message"]'));return {color:style.outlineColor,offset:style.outlineOffset,width:style.outlineWidth};})()`,
  );
  assert.deepEqual(focusRing, { color: "rgb(56, 123, 206)", offset: "-2px", width: "2px" });
  state = evaluate(inspect);
  assert.equal(state.height, 32);
  assert.equal(state.background, "rgb(24, 122, 52)");
  browser(
    "find",
    "label",
    "Commit message",
    "fill",
    "A commit message that wraps across multiple lines. ".repeat(12),
  );
  state = evaluate(inspect);
  assert.equal(state.height, 140);
  evaluate("document.querySelector('[aria-label=\"Commit message\"]').select()");
  browser("press", "Backspace");
  state = evaluate(inspect);
  assert.equal(state.height, 32);
  assert.equal(state.disabled, "true");
  browser("find", "role", "button", "hover", "--name", "Unstage all changes", "--exact");
  browser(
    "wait",
    "--fn",
    "Array.from(document.querySelectorAll('[data-testid=source-control-tooltip]')).some(e=>e.textContent==='Unstage all changes' && Number(getComputedStyle(e).opacity)===1)",
  );
  browser("mouse", "move", "500", "500");
  browser(
    "wait",
    "--fn",
    "document.querySelectorAll('[data-testid=source-control-tooltip]').length===0",
  );
  browser("find", "role", "button", "hover", "--name", "Unstage all changes", "--exact");
  browser(
    "wait",
    "--fn",
    "Array.from(document.querySelectorAll('[data-testid=source-control-tooltip]')).some(e=>e.textContent==='Unstage all changes' && Number(getComputedStyle(e).opacity)===1)",
  );
  const tooltip = evaluate(
    `(() => {const e=document.querySelector('[data-testid=source-control-tooltip]');const text=e.firstElementChild;return {nowrap:getComputedStyle(text).whiteSpace,overflow:text.scrollWidth>text.clientWidth};})()`,
  );
  assert.equal(tooltip.nowrap, "nowrap");
  assert.equal(tooltip.overflow, false, "Action tooltip must fit its text without clipping");
  browser("find", "label", "Commit message", "fill", "fix: price");
  evaluate(
    "window.fixtureErrors=[];window.addEventListener('error',event=>window.fixtureErrors.push(event.message + ' ' + event.error?.stack))",
  );
  browser("find", "role", "button", "click", "--name", "Commit staged changes", "--exact");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Push outgoing commits\"]')");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]') === null",
  );
  assert.equal(
    evaluate(
      `document.querySelector('[aria-label="Push outgoing commits"]').textContent.includes('Push 1↑')`,
    ),
    true,
  );
  evaluate("window.confirm=()=>true");
  browser("find", "role", "button", "click", "--name", "Push outgoing commits", "--exact");
  browser("wait", "--fn", "window.fixtureActions.some(action=>action.kind==='push')");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Commit staged changes\"]')");
  assert.equal(evaluate("window.fixtureActions.filter(action=>action.kind==='push').length"), 1);
  assert.deepEqual(
    evaluate("window.fixtureErrors"),
    [],
    "Commit-to-push transition must not crash the sidebar",
  );
  for (const [option, expected] of [
    ["commit", ["commit"]],
    ["amend", ["amend"]],
    ["commit-push", ["commit", "push"]],
    ["commit-sync", ["commit", "sync"]],
  ]) {
    evaluate("window.resetCommitFixture()");
    browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
    browser("wait", "--text", "Staged Changes");
    browser("find", "label", "Commit message", "fill", "fix: dropdown action");
    browser("select", '[aria-label="Commit options"]', option);
    browser(
      "wait",
      "--fn",
      `window.fixtureActions.length===${expected.length} && !document.querySelector('[aria-busy="true"]')`,
    );
    assert.deepEqual(evaluate("window.fixtureActions.map(action=>action.kind)"), expected);
    assert.equal(evaluate(`document.querySelector('[aria-label="Commit message"]').value`), "");
  }
  evaluate("window.resetCommitFixture();window.confirm=()=>false");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Staged Changes");
  browser("find", "label", "Commit message", "fill", "keep this message");
  browser("select", '[aria-label="Commit options"]', "amend");
  assert.deepEqual(evaluate("window.fixtureActions"), [], "Cancelling amend must not change Git");
  assert.equal(
    evaluate(`document.querySelector('[aria-label="Commit message"]').value`),
    "keep this message",
  );
  evaluate("window.confirm=()=>true;window.failRemote=true");
  browser("select", '[aria-label="Commit options"]', "commit-push");
  browser("wait", "--text", "Remote unavailable");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Push outgoing commits\"]')");
  assert.deepEqual(evaluate("window.fixtureActions.map(action=>action.kind)"), ["commit", "push"]);
  assert.equal(
    evaluate(`document.querySelector('[aria-label="Commit message"]').value`),
    "",
    "Failed push must not restore a message for an already successful commit",
  );
  assert.deepEqual(evaluate("window.fixtureErrors"), []);
  evaluate(
    "window.resetCommitFixture();window.setSourceControlFiles([{path:'conflict.ts',index:'U',worktree:'U',head:'U'},{path:'src/price.tsx',index:'M',worktree:' ',head:'M'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Merge Changes");
  browser("find", "label", "Commit message", "fill", "blocked by conflicts");
  assert.equal(
    evaluate(
      "document.querySelector('[aria-label=\"Commit staged changes\"]').getAttribute('aria-disabled')",
    ),
    "true",
  );
  assert.equal(evaluate("!!document.querySelector('[aria-label=\"Both modified\"]')"), true);
  evaluate(
    "window.resetCommitFixture();window.setSourceControlFiles([{path:'src/a.ts',index:' ',worktree:'M',head:'M'},{path:'src/nested/b.ts',index:' ',worktree:'M',head:'M'},{path:'notes.md',index:'?',worktree:'?',head:'?'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Untracked Changes");
  browser("find", "role", "button", "click", "--name", "Filter changes", "--exact");
  browser("find", "label", "Filter changed files", "fill", "missing-file");
  browser("wait", "--text", "No matching changes.");
  browser("find", "label", "Filter changed files", "fill", "src/");
  browser("find", "role", "button", "click", "--name", "View as Tree", "--exact");
  browser("wait", '[aria-label="Collapse src/"]');
  browser("wait", '[aria-label="Collapse src/nested/"]');
  browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Stage matching files in folder src/",
    "--exact",
  );
  browser("wait", "--fn", "window.fixtureActions.some(action=>action.kind==='stage')");
  assert.deepEqual(evaluate("window.fixtureActions.find(action=>action.kind==='stage').paths"), [
    "src/a.ts",
    "src/nested/b.ts",
  ]);
  evaluate("window.resetCommitFixture()");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Staged Changes");
  browser("find", "label", "Commit message", "fill", "commit via keyboard");
  browser("press", "Control+Enter");
  browser("wait", "--fn", "window.fixtureActions.some(action=>action.kind==='commit')");
  console.log(
    "PASS: SCM sidebar, commit flows and shortcut, conflict gating, filtering, tree view, and scoped folder actions.",
  );
} finally {
  try {
    browser("close");
  } finally {
    preview.kill();
  }
}
