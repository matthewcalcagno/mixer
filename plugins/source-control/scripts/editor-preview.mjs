import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../client/generated/editor-html.ts", import.meta.url),
  "utf8",
);
const html = JSON.parse(
  source
    .slice(source.indexOf("export const editorHtml = ") + "export const editorHtml = ".length)
    .trim()
    .replace(/;$/, ""),
);
const port = Number(process.env.PORT ?? 4319);
const fixture = {
  source: "source-control-host",
  type: "initialize",
  path: "price.tsx",
  editable: true,
  original:
    'import classNames from "classnames";\n\ninterface Props {\n  price: number;\n}\n\nexport function Price({ price }: Props) {\n  return <span className="price">{price}</span>;\n}\n',
  modified:
    'import classNames from "classnames";\n\ninterface Props {\n  price: number;\n  currency: string;\n}\n\nexport function Price({ price, currency }: Props) {\n  return <span className="price">{price} {currency}</span>;\n}\n',
  revision: "fixture-revision",
  light: false,
  bracketPairColorization: true,
  background: "#171b1e",
  foreground: "#e0e4e8",
  muted: "#889099",
  border: "#2e3439",
};
if (process.env.NEW_FILE === "1") fixture.original = "";
const frameHtml = html.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const host = `<!doctype html><html><head><title>price.tsx (Working Tree)</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style></head><body><script>window.editorEvents=[];window.addEventListener('message',function(event){if(event.source!==document.querySelector('iframe')?.contentWindow)return;window.editorEvents.push(event.data);if(event.data.type==='ready')event.source.postMessage(${JSON.stringify(fixture)},'*');if(event.data.type==='save'){window.lastSave=event.data;event.source.postMessage({source:'source-control-host',type:'saved',revision:'saved-revision'},'*');}});</script><iframe title="price.tsx diff editor" srcdoc="${frameHtml}"></iframe></body></html>`;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(request.url === "/editor" ? html : host);
}).listen(port, "127.0.0.1", () =>
  console.log(`Monaco preview http://127.0.0.1:${server.address().port}`),
);
