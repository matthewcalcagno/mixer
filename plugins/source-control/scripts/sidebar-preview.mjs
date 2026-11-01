import { createServer } from "node:http";
import { build as bundle } from "esbuild";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));

const clientShim = `let files=[{path:'src/price.tsx',index:'M',worktree:' ',head:'M'}];let ahead=0;
window.resetCommitFixture=()=>{files=[{path:'src/price.tsx',index:'M',worktree:' ',head:'M'}];ahead=0;window.fixtureActions=[];window.failRemote=false;window.deferDiscard=false;};
window.setSourceControlFiles=(next)=>{files=next;};
export function useRpc(contract) { return async (input) => {
  if(contract.name === 'git.status') return {branch:'develop',upstream:'origin/develop',ahead,behind:0,hasRemote:true,revision:'fixture',files};
  if(contract.name === 'git.autofetch') return {lastFetched:Date.now(),error:null};
  if(contract.name === 'git.action') {
    window.fixtureActions ??= [];window.fixtureActions.push(input.action);
    if(input.action.kind === 'discard') {
      if(window.deferDiscard) await new Promise((resolve,reject)=>{window.completeDiscard=resolve;window.rejectDiscard=()=>reject(new Error('Discard failed'));});
      files=files.flatMap(file=>!input.action.paths.includes(file.path)?[file]:file.index===' '?[]:[{...file,worktree:' ',head:file.index}]);
    }
    if(input.action.kind === 'commit' || input.action.kind === 'amend') {files=[];ahead++;}
    if(input.action.kind === 'push' || input.action.kind === 'sync') {
      if(window.failRemote) throw new Error('Remote unavailable');
      ahead=0;
    }
  }
  return {message:'Done'};
}; }`;
const uiShim = `import {createElement} from 'react'; export {ScrollView} from 'react-native'; export function ContextMenu({children}) {return children;} export function useEditorSyntaxOptions() { return {bracketPairColorization:true}; } export function Icon({name,icon,color,size}) { window.fixtureIconRenders=(window.fixtureIconRenders ?? 0)+1; return createElement('span', {'data-icon':name ?? 'file',style:{color,fontSize:size,lineHeight:1}}, '◇'); }
export function PaneHeader({title,children,testID,titleTestID}) { return createElement('div', {'data-testid':testID,style:{height:36,flexShrink:0,display:'flex',alignItems:'center',paddingRight:4}}, createElement('div',{'data-testid':titleTestID,style:{flex:1,minWidth:0,marginLeft:12,marginRight:8,fontSize:14,fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}},title),createElement('div',{style:{display:'flex',gap:1,flexShrink:0}},children)); }
export function PaneHeaderAction({icon,label,onPress,disabled,testID}) {return createElement('button',{'aria-label':label,'data-testid':testID,disabled,onClick:onPress,style:{width:20,height:20,border:0,padding:0,background:'transparent'}},createElement(Icon,{name:icon,size:14,color:'#9da5ae'}));}`;
const output = await bundle({
  absWorkingDir: process.cwd(),
  entryPoints: ["scripts/sidebar-fixture.jsx"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { global: "globalThis", "process.env.NODE_ENV": '"development"', __DEV__: "true" },

  plugins: [
    {
      name: "mixer-fixture",
      setup(build) {
        build.onResolve({ filter: /^react-native$/ }, () => ({
          path: "react-native",
          namespace: "native-fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "native-fixture" }, () => ({
          contents: "export * from 'react-native-web'; export const ActionSheetIOS = undefined;",
          loader: "js",
          resolveDir: process.cwd(),
        }));
        build.onResolve({ filter: /^@mixer\/plugin\/client(?:\/ui)?$/ }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("/ui") ? uiShim : clientShim,
          loader: "js",
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});
const javascript = output.outputFiles[0].text;
const html =
  '<!doctype html><html><head><title>Source Control sidebar fixture</title><style>html,body{margin:0;height:100%;background:#171b1e}#root{height:100%;width:360px;display:flex;flex-direction:column;border-right:1px solid #363d46}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/bundle.js" ? "text/javascript" : "text/html",
  );
  response.end(request.url === "/bundle.js" ? javascript : html);
}).listen(Number(process.env.PORT ?? 4320), "127.0.0.1", () =>
  console.log(`Sidebar fixture http://127.0.0.1:${server.address().port}`),
);
