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
  evaluate(
    "window.resetCommitFixture();window.actionFailure={kind:'commit',error:{code:'identity',conflict:false,command:'git commit',message:'Author identity unknown'}}",
  );
  browser("find", "label", "Commit message", "fill", "preserve my identity draft");
  browser("find", "role", "button", "click", "--name", "Commit staged changes", "--exact");
  browser("wait", "--text", "Configure your Git identity");
  assert.equal(
    evaluate("document.querySelector('[aria-label=\"Commit message\"]').value"),
    "preserve my identity draft",
  );
  browser("find", "role", "button", "click", "--name", "Configure Git identity", "--exact");
  browser("find", "label", "Git author name", "fill", "Mixer Author");
  browser("find", "label", "Git author email", "fill", "invalid");
  assert.equal(
    evaluate(
      "Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='Save for this repository').disabled",
    ),
    true,
  );
  browser("find", "label", "Git author email", "fill", "author@example.test");
  evaluate(
    "window.actionFailure={kind:'configure-identity',error:{code:'unknown',conflict:false,message:'could not lock config file'}}",
  );
  browser("find", "role", "button", "click", "--name", "Save for this repository", "--exact");
  browser("wait", "--text", "could not lock config file");
  evaluate("window.actionFailure=null");
  browser("find", "role", "button", "click", "--name", "Save for this repository", "--exact");
  browser("wait", "--text", "Git identity saved");
  assert.deepEqual(evaluate("window.fixtureActions.at(-1)"), {
    kind: "configure-identity",
    name: "Mixer Author",
    email: "author@example.test",
  });
  browser("find", "role", "button", "click", "--name", "Close Configure Git identity", "--exact");
  assert.equal(
    evaluate("document.querySelector('[aria-label=\"Commit message\"]').value"),
    "preserve my identity draft",
  );
  browser("find", "role", "button", "click", "--name", "Dismiss Git error", "--exact");
  for (const [code, title] of [
    ["hook", "Git hook blocked the operation"],
    ["empty-cherry-pick", "No changes left to cherry-pick"],
    ["unknown", "Git operation failed"],
  ]) {
    evaluate(
      `window.actionFailure={kind:'commit',error:{code:${JSON.stringify(code)},conflict:false,command:'git commit',message:'diagnostic output'}}`,
    );
    browser("find", "role", "button", "click", "--name", "Commit staged changes", "--exact");
    browser("wait", "--text", title);
    assert.equal(evaluate("document.body.textContent.includes('diagnostic output')"), false);
    browser("find", "role", "button", "click", "--name", "Dismiss Git error", "--exact");
  }
  evaluate("window.resetCommitFixture()");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("find", "label", "Commit message", "fill", "review blocked changes");
  evaluate(
    "window.actionFailure={kind:'commit',error:{code:'local-changes',conflict:false,message:'commit or stash changes'}}",
  );
  browser("find", "role", "button", "click", "--name", "Commit staged changes", "--exact");
  browser("wait", "--text", "Local changes block this operation");
  browser("find", "role", "button", "click", "--name", "Review changes", "--exact");
  assert.deepEqual(evaluate("window.openedSourceControlDiff"), {
    path: "src/price.tsx",
    staged: true,
  });
  browser("find", "role", "button", "click", "--name", "Dismiss Git error", "--exact");
  evaluate(
    "window.actionFailure={kind:'commit',error:{code:'conflict',conflict:true,message:'conflicts'}}",
  );
  browser("find", "role", "button", "click", "--name", "Commit staged changes", "--exact");
  browser("wait", "--text", "Resolve conflicts to continue");
  evaluate("window.setSourceControlFiles([{path:'conflict.ts',index:'U',worktree:'U',head:'U'}])");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Merge Changes");
  browser("find", "role", "button", "click", "--name", "Show conflicts", "--exact");
  assert.equal(evaluate("window.openedSourceControlFile"), "conflict.ts");
  browser("find", "role", "button", "click", "--name", "Dismiss Git error", "--exact");
  evaluate(
    "window.resetCommitFixture();window.failRemote={code:'authentication',conflict:false,command:'git push',message:'Authentication failed'}",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Staged Changes");
  browser("select", '[aria-label="Commit options"]', "commit-push");
  browser("wait", "--text", "Could not authenticate with the remote");
  evaluate("window.failRemote=false");
  browser("find", "role", "button", "click", "--name", "Retry", "--exact");
  browser("wait", "--fn", "!document.querySelector('[role=alert]')");
  assert.deepEqual(evaluate("window.fixtureActions.map(action=>action.kind)"), [
    "commit",
    "push",
    "push",
  ]);
  evaluate("window.resetCommitFixture()");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
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
    "window.fixtureActions=[];window.confirm=()=>false;window.setSourceControlFiles([{path:'tracked.ts',index:' ',worktree:'M',head:'M'},{path:'new.ts',index:'?',worktree:'?',head:'?'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", '[aria-label="Open working tree diff for tracked.ts"]');
  browser("find", "role", "button", "click", "--name", "Discard all changes", "--exact");
  const headerActions = evaluate(
    `(() => {const undo=document.querySelector('[aria-label="Discard all changes"]').getBoundingClientRect();const stage=document.querySelector('[aria-label="Stage all changes"]').getBoundingClientRect();return {gap:stage.left-undo.right,aligned:stage.top===undo.top};})()`,
  );
  assert.equal(headerActions.aligned, true);
  assert.ok(
    headerActions.gap >= 0 && headerActions.gap <= 4,
    "Discard must sit immediately before stage-all",
  );
  assert.deepEqual(evaluate("window.fixtureActions"), [], "Cancel must preserve all changes");
  evaluate("window.confirm=()=>true");
  browser("find", "role", "button", "click", "--name", "Discard all changes", "--exact");
  browser("wait", "--fn", "window.fixtureActions.some(action=>action.kind==='discard')");
  assert.deepEqual(evaluate("window.fixtureActions.find(action=>action.kind==='discard').paths"), [
    "tracked.ts",
  ]);
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent==='1'",
  );
  evaluate(
    "window.fixtureActions=[];window.confirm=()=>{throw new Error('Staging must not confirm')};window.setSourceControlFiles([{path:'a.ts',index:' ',worktree:'M',head:'M'},{path:'b.ts',index:'?',worktree:'?',head:'?'}])",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", '[aria-label="Open working tree diff for a.ts"]');
  browser("find", "role", "button", "hover", "--name", "Stage all changes", "--exact");
  browser(
    "wait",
    "--fn",
    `Array.from(document.querySelectorAll('[data-testid="source-control-tooltip"]')).some(el=>el.textContent==='Stage all changes' && getComputedStyle(el).opacity==='1')`,
  );
  browser("find", "role", "button", "click", "--name", "Stage all changes", "--exact");
  browser("wait", '[aria-label="Open staged diff for b.ts"]');
  browser("mouse", "move", "500", "500");
  browser("find", "role", "button", "click", "--name", "Unstage all changes", "--exact");
  browser("wait", '[aria-label="Open working tree diff for b.ts"]');
  browser("mouse", "move", "500", "500");
  browser(
    "wait",
    "--fn",
    `document.querySelectorAll('[data-testid="source-control-tooltip"]').length===0`,
  );
  // Focus must still reveal a tooltip after the previous action dismissed it.
  evaluate(`document.querySelector('[aria-label="Stage all changes"]').focus()`);
  browser(
    "wait",
    "--fn",
    `Array.from(document.querySelectorAll('[data-testid="source-control-tooltip"]')).some(el=>el.textContent==='Stage all changes' && getComputedStyle(el).opacity==='1')`,
  );
  browser("find", "role", "button", "click", "--name", "Stage all changes", "--exact");
  browser("wait", '[aria-label="Open staged diff for b.ts"]');
  assert.equal(
    evaluate(
      `document.querySelector('[aria-label="Collapse Changes"]').parentElement.textContent.endsWith('0')`,
    ),
    true,
  );
  evaluate("window.confirm=()=>true");
  evaluate(
    "window.setSourceControlFiles(Array.from({length:500},(_,i)=>({path:'src/file-'+i+'.ts',index:'M',worktree:' ',head:'M'})))",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", '[aria-label="Open staged diff for src/file-499.ts"]');
  browser("find", "label", "Commit message", "fill", "fix:");
  const rendersBeforeTyping = evaluate("window.fixtureIconRenders");
  browser("type", '[aria-label="Commit message"]', " keep typing with 500 staged files");
  const typingIconRenders = evaluate("window.fixtureIconRenders") - rendersBeforeTyping;
  assert.ok(
    typingIconRenders < 100,
    `Typing rerendered the resource list: ${typingIconRenders} icons`,
  );
  evaluate("document.querySelector('[aria-label=\"Commit message\"]').select()");
  browser("press", "Backspace");
  evaluate("window.resetCommitFixture()");
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]')?.textContent === '1'",
  );
  const inspect = `(() => {const input=document.querySelector('[aria-label="Commit message"]');const button=document.querySelector('[aria-label="Commit staged changes"]');return {height:input.getBoundingClientRect().height,disabled:button.getAttribute('aria-disabled'),background:getComputedStyle(button).backgroundColor,text:document.body.innerText,icon:getComputedStyle(document.querySelector('[data-icon="RotateCw"]')).color};})()`;
  let state = evaluate(inspect);
  assert.equal(state.height, 28);
  assert.equal(state.disabled, "true", JSON.stringify(state));
  assert.ok(state.text.includes('Commit message for "develop"'));
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
  browser("wait", "--text", "Git operation failed");
  browser("find", "role", "button", "click", "--name", "View command output", "--exact");
  browser("wait", "--text", "Discard failed");
  browser("find", "role", "button", "click", "--name", "Close Git command output", "--exact");
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
  assert.equal(state.height, 28);
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
  assert.equal(state.height, 28);
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
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Sync changes\"]')");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[data-testid=source-control-change-badge]') === null",
  );
  assert.equal(
    evaluate(
      `document.querySelector('[aria-label="Sync changes"]').textContent.includes('Sync Changes 1↑')`,
    ),
    true,
  );
  evaluate("window.confirm=()=>false");
  browser("find", "role", "button", "click", "--name", "Sync changes", "--exact");
  assert.equal(evaluate("window.fixtureActions.filter(action=>action.kind==='sync').length"), 0);
  evaluate("window.confirm=()=>true");
  browser("find", "role", "button", "click", "--name", "Sync changes", "--exact");
  browser("wait", "--fn", "window.fixtureActions.some(action=>action.kind==='sync')");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Commit staged changes\"]')");
  assert.equal(evaluate("window.fixtureActions.filter(action=>action.kind==='sync').length"), 1);
  assert.deepEqual(
    evaluate("window.fixtureErrors"),
    [],
    "Commit-to-sync transition must not crash the sidebar",
  );
  for (const [option, expected] of [
    ["commit", ["commit"]],
    ["amend", ["amend"]],
    ["commit-push", ["commit", "push"]],
    ["commit-sync", ["commit", "sync"]],
  ]) {
    evaluate(
      `window.resetCommitFixture();window.confirm=${option === "commit-push" ? "()=>{throw new Error('Commit & Sync must not ask for confirmation')}" : "()=>true"}`,
    );
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
  evaluate(
    "window.resetCommitFixture();window.deferRemote=true;window.confirm=()=>{throw new Error('Commit & Push must not confirm')}",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Staged Changes");
  browser("find", "label", "Commit message", "fill", "keep operation label while pushing");
  browser("select", '[aria-label="Commit options"]', "commit-push");
  browser("wait", "--fn", "typeof window.completeRemote === 'function'");
  assert.equal(
    evaluate(`document.querySelector('[aria-label="Commit & Push"]').textContent.trim()`),
    "Commit & Push",
  );
  assert.equal(
    evaluate(`document.querySelector('[aria-label="Commit & Push"]').getAttribute('aria-busy')`),
    "true",
  );
  assert.equal(evaluate(`document.querySelector('[aria-label="Commit message"]').value`), "");
  assert.equal(evaluate(`!!document.querySelector('[aria-label="Collapse Changes"]')`), false);
  assert.equal(
    evaluate(
      `getComputedStyle(document.querySelector('[aria-label="Commit & Push"]')).backgroundColor`,
    ),
    "rgb(24, 122, 52)",
  );
  evaluate("window.completeRemote()");
  browser("wait", "--fn", "!document.querySelector('[aria-busy=true]')");
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
  browser("wait", "--text", "Could not reach the remote");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Sync changes\"]')");
  assert.deepEqual(evaluate("window.fixtureActions.map(action=>action.kind)"), ["commit", "push"]);
  assert.equal(
    evaluate(`document.querySelector('[aria-label="Commit message"]').value`),
    "",
    "Failed push must not restore a message for an already successful commit",
  );
  assert.deepEqual(evaluate("window.fixtureErrors"), []);
  evaluate(
    `window.resetCommitFixture();window.failRemote={code:'push-rejected',conflict:false,command:'git push',message:'To https://example.com/repo.git\\n ! [rejected] main -> main (non-fast-forward)\\nerror: failed to push some refs'};window.confirm=()=>true`,
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--text", "Staged Changes");
  browser("find", "label", "Commit message", "fill", "preserve rejected commit");
  browser("select", '[aria-label="Commit options"]', "commit-push");
  browser("wait", "--text", "Push rejected");
  assert.equal(evaluate("document.querySelector('[role=alert]').textContent"), "Push rejected");
  assert.equal(evaluate("document.body.textContent.includes('non-fast-forward')"), false);
  browser("find", "role", "button", "click", "--name", "View command output", "--exact");
  browser("wait", "--text", "non-fast-forward");
  evaluate("window.failCopy=true");
  browser("find", "role", "button", "click", "--name", "Copy details", "--exact");
  browser("wait", "--text", "Could not copy the command output");
  evaluate("window.failCopy=false");
  browser("find", "role", "button", "click", "--name", "Copy details", "--exact");
  browser("wait", "--text", "Copied");
  assert.equal(
    evaluate("window.copiedGitDetails.startsWith('git push\\n\\nTo https://example.com/repo.git')"),
    true,
  );
  browser("find", "role", "button", "click", "--name", "Close Git command output", "--exact");
  evaluate("window.confirm=()=>false");
  browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Sync changes to resolve rejected push",
    "--exact",
  );
  assert.deepEqual(evaluate("window.fixtureActions.map(action=>action.kind)"), ["commit", "push"]);
  evaluate("window.failRemote=false;window.confirm=()=>true");
  browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Sync changes to resolve rejected push",
    "--exact",
  );
  browser("wait", "--fn", "!document.querySelector('[role=alert]')");
  assert.deepEqual(evaluate("window.fixtureActions.map(action=>action.kind)"), [
    "commit",
    "push",
    "sync",
  ]);
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
  browser("wait", '[aria-label="Open file notes.md"]');
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
  evaluate(
    "window.resetCommitFixture();window.setSourceControlFiles([]);window.setSourceControlBehind(4)",
  );
  browser("find", "role", "button", "click", "--name", "Refresh", "--exact");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Pull incoming commits\"]')");
  evaluate("window.deferStatus=true");
  browser("wait", "--fn", "typeof window.completeStatus === 'function'");
  assert.notEqual(
    evaluate(
      "document.querySelector('[aria-label=\"Pull incoming commits\"]').getAttribute('aria-disabled')",
    ),
    "true",
    "Background polling must keep Pull enabled",
  );
  evaluate(
    "window.deferStatus=false;window.completeStatus();delete window.completeStatus;window.deferRemote=true",
  );
  browser("find", "role", "button", "click", "--name", "Pull incoming commits", "--exact");
  browser("wait", "--fn", "typeof window.completeRemote === 'function'");
  browser(
    "wait",
    "--fn",
    "document.querySelector('[aria-label=\"Pull incoming commits\"]')?.getAttribute('aria-disabled') === 'true'",
  );
  assert.equal(
    evaluate(
      "document.querySelector('[aria-label=\"Pull incoming commits\"]').getAttribute('aria-disabled')",
    ),
    "true",
    "An actual Pull must disable the action until it completes",
  );
  evaluate("window.completeRemote()");
  browser("wait", "--fn", "!!document.querySelector('[aria-label=\"Commit staged changes\"]')");
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
