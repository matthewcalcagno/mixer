import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, "../../../../../public/monaco");
await mkdir(output, { recursive: true });
const editorBuild = await build({
  metafile: true,
  entryPoints: { editor: path.join(root, "runtime.ts") },
  outdir: output,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: true,
  loader: { ".ttf": "file" },
  alias: {
    "monaco-editor/esm/vs/editor/editor.api": "monaco-editor/esm/vs/editor/editor.api.js",
  },
  logLevel: "info",
});

const modules = new Set();
function includeModule(filename) {
  const asset = path.relative(output, path.resolve(filename));
  if (!asset.endsWith(".js") || modules.has(asset)) return;
  modules.add(asset);
  for (const dependency of editorBuild.metafile.outputs[filename]?.imports ?? []) {
    if (dependency.kind === "import-statement") includeModule(dependency.path);
  }
}
for (const [filename, metadata] of Object.entries(editorBuild.metafile.outputs)) {
  const entry = metadata.entryPoint?.replaceAll("\\", "/") ?? "";
  const commonGrammar =
    /\/(?:typescript|tsx|javascript|jsx|python|json|html|css|markdown|wasm|wasm-inlined)\.mjs$/.test(
      entry,
    );
  const nativeConfiguration =
    /\/basic-languages\/(?:typescript|javascript|python|json|html|css|markdown)\/[^/]+\.js$/.test(
      entry,
    );
  if (filename.endsWith("/editor.js") || commonGrammar || nativeConfiguration)
    includeModule(filename);
}
const fonts = Object.keys(editorBuild.metafile.outputs)
  .filter((filename) => filename.endsWith(".ttf"))
  .map((filename) => path.relative(output, path.resolve(filename)));
await writeFile(
  path.join(output, "preload.json"),
  JSON.stringify({ modules: [...modules].sort(), styles: ["editor.css"], fonts }),
);

await build({
  entryPoints: {
    "editor.worker": require.resolve("monaco-editor/esm/vs/editor/editor.worker.js"),
    "ts.worker": require.resolve("monaco-editor/esm/vs/language/typescript/ts.worker.js"),
    "json.worker": require.resolve("monaco-editor/esm/vs/language/json/json.worker.js"),
    "css.worker": require.resolve("monaco-editor/esm/vs/language/css/css.worker.js"),
    "html.worker": require.resolve("monaco-editor/esm/vs/language/html/html.worker.js"),
    "json-lsp.worker": path.join(root, "json-server.ts"),
  },
  outdir: output,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  logLevel: "info",
});

await writeFile(
  path.join(output, "bootstrap.js"),
  `window.addEventListener("error", function(event) {
  if (event.target instanceof HTMLScriptElement) {
    window.parent.postMessage({type:"error",message:"Source editor assets failed to load. Retry the editor."}, window.location.origin);
  }
}, true);`,
);

await writeFile(
  path.join(output, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="./editor.css">
<style>html,body,#editor{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex;flex-direction:column}#editor{flex:1;min-height:0}#vim-status{font:12px monospace;flex-shrink:0}#vim-status:empty{display:none}</style>
</head><body><div id="editor"></div><div id="vim-status"></div><script src="./bootstrap.js"></script><script type="module" src="./editor.js"></script></body></html>`,
);
