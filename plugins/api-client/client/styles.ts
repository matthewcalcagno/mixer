import type { CSSProperties } from "react";
import type { PluginTheme } from "@mixer/plugin";

export function themeStyle(theme: PluginTheme): CSSProperties {
  const colors = Object.fromEntries(
    Object.entries(theme.colors).map(([key, value]) => [`--ac-${key}`, value]),
  );
  const typography = theme.typography;
  return {
    ...colors,
    colorScheme: theme.colorScheme,
    "--ac-variable-set": theme.colorScheme === "dark" ? "#6a9de0" : "#2563eb",
    "--ac-font-ui": typography?.fontFamily ?? "system-ui, sans-serif",
    "--ac-code-font": typography?.monoFontFamily ?? "ui-monospace, monospace",
    "--ac-font-base": `${typography?.base ?? 14}px`,
    "--ac-font-chrome": `${typography?.chrome ?? 13}px`,
    "--ac-font-small": `${typography?.small ?? 12}px`,
    "--ac-radius": `${typography?.radius ?? 8}px`,
  } as CSSProperties;
}
export const css = `
.ac-root { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; overflow:hidden; background:transparent; color:var(--ac-foreground); font-family:var(--ac-font-ui); font-size:var(--ac-font-chrome); line-height:1.45; position:relative; }
.ac-root * { box-sizing:border-box; }
.ac-root p { margin:0; }
.ac-root button,.ac-root input,.ac-root select,.ac-root textarea { font:inherit; color:inherit; }
.ac-root button { cursor:pointer; }
.ac-root button:disabled { cursor:default; opacity:.45; }
.ac-root input:not([type=checkbox]):not([type=file]),.ac-root select,.ac-root textarea { background:var(--ac-surface1); border:1px solid var(--ac-border); border-radius:var(--ac-radius); padding:6px 9px; min-width:0; outline:none; }
.ac-root input::placeholder,.ac-root textarea::placeholder { color:var(--ac-foregroundMuted); opacity:.8; }
.ac-root input[type=checkbox] { accent-color:var(--ac-accent); width:13px; height:13px; margin:0; }
.ac-root input:focus-visible,.ac-root textarea:focus-visible,.ac-root select:focus-visible,.ac-root button:focus-visible { outline:2px solid var(--ac-inputFocus); outline-offset:-2px; }
.ac-root select option { color:var(--ac-foreground); background:var(--ac-surface1); }
.ac-action,.ac-icon-button { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
.ac-inline { display:flex; gap:8px; align-items:center; min-width:0; }
.ac-workbench { display:flex; flex:1; min-height:0; min-width:0; }
.ac-main { flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.ac-request-tabs { display:flex; overflow:auto; flex-shrink:0; border-bottom:1px solid var(--ac-border); min-height:35px; background:var(--ac-surface1); }
.ac-request-tab { display:flex; align-items:center; flex-shrink:0; min-width:0; max-width:240px; border-right:1px solid var(--ac-border); }
.ac-request-tab[data-active=true] { background:var(--ac-surface0); }
.ac-request-tab > button:first-child { flex:1; display:flex; align-items:center; gap:8px; overflow:hidden; text-align:left; padding:8px 12px; background:none; border:0; min-width:0; }
.ac-request-tab .ac-icon-button { margin-right:4px; }
.ac-truncate { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ac-method { color:var(--ac-statusSuccess); font-size:var(--ac-font-small); font-weight:500; flex-shrink:0; }
.ac-method[data-method=POST],.ac-method[data-method=OPTIONS] { color:var(--ac-statusWarning); }
.ac-method[data-method=DELETE] { color:var(--ac-statusDanger); }
.ac-method[data-method=PUT],.ac-method[data-method=PATCH],.ac-method[data-method=HEAD] { color:var(--ac-accent); }
.ac-request-heading { min-height:46px; padding:8px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-shrink:0; }
.ac-request-identity { display:flex; align-items:center; gap:8px; min-width:0; white-space:nowrap; overflow:hidden; }
.ac-request-identity > span:last-child { overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.ac-heading-divider { color:var(--ac-foregroundMuted); }
.ac-request-actions { display:flex; align-items:center; flex-shrink:0; }
.ac-request-bar { display:flex; padding:0 16px 16px; gap:10px; flex-shrink:0; }
.ac-url-frame { flex:1; display:flex; align-items:stretch; border:1px solid var(--ac-border); border-radius:var(--ac-radius); background:var(--ac-surface1); min-width:0; min-height:36px; overflow:hidden; }
.ac-url-frame:focus-within { border-color:var(--ac-inputFocus); }
.ac-url-frame select { width:90px; border:0!important; border-right:1px solid var(--ac-border)!important; border-radius:0!important; font-weight:500; }
.ac-url-frame input { flex:1; border:0!important; background:transparent!important; font-family:var(--ac-code-font)!important; outline:0!important; padding:8px 12px!important; }
.ac-send { display:inline-flex; align-items:center; }
.ac-editor-split { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.ac-request-pane { flex-shrink:0; min-height:0; min-width:0; overflow:hidden; }
.ac-request-options { height:100%; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.ac-section-tabs { display:flex; gap:18px; padding:0 16px; border-bottom:1px solid var(--ac-border); overflow:auto; flex-shrink:0; min-height:36px; }
.ac-section-tabs button { background:none; border:0; border-bottom:2px solid transparent; border-radius:0; padding:8px 0; white-space:nowrap; color:var(--ac-foregroundMuted); }
.ac-section-tabs button:hover { color:var(--ac-foreground); }
.ac-section-tabs button[aria-selected=true] { color:var(--ac-foreground); border-bottom-color:var(--ac-foreground); }
.ac-editor-content { padding:16px; overflow:auto; min-height:0; flex:1; }
.ac-editor-content[data-section=Authorization],.ac-editor-content[data-section=Settings] { max-width:660px; width:100%; }
.ac-editor-content[data-section=Body] { display:flex; flex-direction:column; gap:12px; }
.ac-editor-content[data-section=Body] > .ac-code-editor { flex:1; min-height:100px; resize:none; border-radius:0; border:0; background:transparent; padding:0; }
.ac-field { display:flex; flex-direction:column; gap:6px; margin-bottom:16px; min-width:0; }
.ac-field > span { font-weight:500; }
.ac-field small,.ac-muted { color:var(--ac-foregroundMuted); font-size:var(--ac-font-small); }
.ac-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:16px; }
.ac-pair-editor { display:flex; flex-direction:column; }
.ac-pair-heading,.ac-pair-row { display:grid; grid-template-columns:28px minmax(80px,1fr) minmax(100px,1.5fr) 28px; align-items:center; }
.ac-pair-heading { color:var(--ac-foregroundMuted); font-size:var(--ac-font-small); background:var(--ac-surface1); border:1px solid var(--ac-border); min-height:30px; }
.ac-pair-heading > span { padding:4px 8px; }
.ac-pair-row { border:1px solid var(--ac-border); border-top:0; min-height:34px; }
.ac-pair-row > input[type=checkbox] { justify-self:center; }
.ac-root .ac-pair-row input:not([type=checkbox]):not([type=file]) { border:0; border-left:1px solid var(--ac-border); border-radius:0; padding:8px; width:100%; background:transparent; }
.ac-pair-value { display:flex; flex-direction:column; gap:4px; overflow:hidden; }
.ac-pair-value input[type=file] { max-width:100%; font-size:var(--ac-font-small); }
.ac-pair-editor > .ac-action { margin-top:8px; align-self:flex-start; }
.ac-file-name { font-family:var(--ac-code-font); overflow:hidden; text-overflow:ellipsis; padding:8px; }
.ac-code-editor { display:block; width:100%; min-height:150px; resize:vertical; font-family:var(--ac-code-font)!important; line-height:1.65; tab-size:2; }
.ac-resize-handle { height:7px; flex-shrink:0; cursor:row-resize; display:flex; align-items:center; justify-content:center; border-block:1px solid var(--ac-border); touch-action:none; }
.ac-resize-handle > span { width:28px; height:2px; border-radius:2px; background:var(--ac-border); }
.ac-resize-handle:hover,.ac-resize-handle:focus-visible { background:var(--ac-surface2); outline:0; }
.ac-resize-handle:hover > span,.ac-resize-handle:focus-visible > span { background:var(--ac-accent); }
.ac-editor-split[data-columns=true] { flex-direction:row; }
.ac-editor-split[data-columns=true] > .ac-resize-handle { width:7px; height:auto; cursor:col-resize; border-block:0; border-inline:1px solid var(--ac-border); }
.ac-editor-split[data-columns=true] > .ac-resize-handle > span { width:2px; height:28px; }
.ac-response { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.ac-response-head { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:37px; padding:0 16px; border-bottom:1px solid var(--ac-border); flex-shrink:0; flex-wrap:wrap; }
.ac-response-head > .ac-section-tabs { border:0; padding:0; }
.ac-status { font-weight:500; color:var(--ac-statusSuccess); }
.ac-status[data-error=true] { color:var(--ac-statusDanger); }
.ac-response-stats { white-space:nowrap; flex-shrink:0; }
.ac-response-type { max-width:160px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.ac-response-tools { display:flex; justify-content:space-between; align-items:center; padding:10px 16px; gap:8px; flex-wrap:wrap; flex-shrink:0; }
.ac-response-tools input { max-width:180px; width:100%; }
.ac-response-body { flex:1; overflow:auto; min-height:0; padding:6px 16px 16px; }
.ac-response-body pre { margin:0; font-family:var(--ac-code-font)!important; font-size:var(--ac-font-chrome); line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; tab-size:2; }
.ac-response-body[data-wrap=false] pre { white-space:pre; overflow-wrap:normal; }
.ac-response-table { width:100%; border-collapse:collapse; font-family:var(--ac-code-font); font-size:var(--ac-font-chrome); table-layout:fixed; }
.ac-response-table td { padding:8px; vertical-align:top; border-bottom:1px solid var(--ac-border); overflow-wrap:anywhere; user-select:text; }
.ac-response-table td:first-child { width:32%; color:var(--ac-foregroundMuted); }
.ac-empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:24px; text-align:center; color:var(--ac-foregroundMuted); }
.ac-empty strong { font-weight:500; color:var(--ac-foreground); }
.ac-notice { display:flex; gap:8px; align-items:center; padding:8px 16px; background:var(--ac-surface2); color:var(--ac-foreground); border-bottom:1px solid var(--ac-border); font-size:var(--ac-font-small); }
.ac-notice[data-error=true] { color:var(--ac-statusDanger); }
.ac-side { width:290px; min-width:270px; max-width:40%; border-left:1px solid var(--ac-border); background:var(--ac-surface1); display:flex; flex-direction:column; min-height:0; }
.ac-side > .ac-section-tabs { gap:16px; padding:0 12px; min-height:36px; }
.ac-side-scroll { overflow:auto; padding:8px; flex:1; }
.ac-side-search { padding:12px; }
.ac-side-search input { width:100%; }
.ac-side-toolbar { display:flex; gap:6px; align-items:center; justify-content:space-between; padding:0 8px 8px; }
.ac-library-row { display:flex; align-items:center; gap:5px; min-height:30px; border-radius:var(--ac-radius); }
.ac-library-row[data-active=true],.ac-library-row:hover { background:var(--ac-surface2); }
.ac-library-row > button:first-child { flex:1; background:none; border:0; padding:7px 8px; text-align:left; display:flex; gap:8px; align-items:center; min-width:0; }
.ac-library-row .ac-icon-button,.ac-group-title > .ac-icon-button:not(:first-child) { opacity:0; }
.ac-library-row:hover .ac-icon-button,.ac-library-row:focus-within .ac-icon-button,.ac-group-title:hover > .ac-icon-button,.ac-group-title:focus-within > .ac-icon-button { opacity:1; }
.ac-group { margin-bottom:12px; }
.ac-group-title { display:flex; align-items:center; gap:4px; min-height:30px; }
.ac-group-title > input { border:0!important; background:transparent!important; font-weight:500!important; flex:1; padding:6px!important; }
.ac-group-requests { padding-left:20px; }
.ac-history-item { display:flex; flex-direction:column; align-items:stretch!important; gap:5px!important; }
.ac-history-line { display:flex; align-items:center; gap:7px; min-width:0; }
.ac-history-details { color:var(--ac-foregroundMuted); font-size:var(--ac-font-small); }
.ac-root.ac-dialog { background:transparent; height:auto; overflow:visible; font-size:var(--ac-font-base); line-height:1.5; gap:16px; }
.ac-dialog .ac-field { margin-bottom:0; }
.ac-dialog textarea { min-height:180px; }
.ac-dialog-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:8px; }
.ac-hidden { display:none; }
.ac-root[data-compact=true] .ac-response-tools { flex-wrap:wrap; }
.ac-root[data-compact=true] .ac-request-heading { padding-inline:12px; }
.ac-root[data-compact=true] .ac-request-bar { padding-inline:12px; }
.ac-root[data-compact=true] .ac-request-identity > .ac-muted,.ac-root[data-compact=true] .ac-heading-divider { display:none; }
.ac-root[data-compact=true] .ac-side { position:absolute; z-index:10; right:0; top:36px; bottom:0; width:min(340px,100%); max-width:100%; }
.ac-root[data-compact=true] .ac-side .ac-icon-button { opacity:1; }

.ac-section-tabs button { display:inline-flex; gap:5px; align-items:center; }
.ac-tab-dot { width:6px; height:6px; border-radius:50%; background:var(--ac-statusSuccess); flex-shrink:0; }
.ac-tab-count { color:var(--ac-statusSuccess); font-size:var(--ac-font-small); }
.ac-editor-content[data-section=Authorization],.ac-editor-content[data-section=Body],.ac-editor-content[data-section=Settings] { max-width:none; padding:0; }
.ac-authorization { display:grid; grid-template-columns:minmax(200px,32%) minmax(0,1fr); min-height:100%; }
.ac-auth-type { padding:20px; border-right:1px solid var(--ac-border); }
.ac-auth-type .ac-field { display:grid; grid-template-columns:50px minmax(0,1fr); align-items:center; }
.ac-auth-fields { padding:20px 24px; display:flex; flex-direction:column; gap:18px; }
.ac-auth-fields .ac-field { display:grid; grid-template-columns:95px minmax(0,1fr); align-items:center; margin:0; }
.ac-auth-fields input,.ac-auth-fields select { width:100%; max-width:460px; }
.ac-headers-toolbar { position:sticky; top:0; z-index:1; background:var(--ac-surface0); display:flex; align-items:center; gap:12px; margin-bottom:10px; }
.ac-generated-header { user-select:text; color:var(--ac-foregroundMuted); background:var(--ac-surface1); }
.ac-generated-header > span { padding:8px; overflow-wrap:anywhere; min-width:0; }
.ac-generated-header > span + span { border-left:1px solid var(--ac-border); }
.ac-generated-header > span:first-child { padding:0; justify-self:center; }
.ac-body-editor { display:flex; flex-direction:column; height:100%; min-height:0; }
.ac-body-toolbar { display:flex; align-items:center; gap:16px; padding:12px 16px; flex-wrap:wrap; flex-shrink:0; }
.ac-body-modes { display:contents; }
.ac-body-modes label { display:flex; align-items:center; gap:6px; white-space:nowrap; cursor:pointer; }
.ac-body-modes input { margin:0; accent-color:var(--ac-accent); }
.ac-body-fields { padding:0 16px 16px; overflow:auto; }
.ac-body-empty { padding:20px 16px; }
.ac-raw-editor { flex:1; min-height:120px; display:flex; border-top:1px solid var(--ac-border); overflow:hidden; }
.ac-code-gutter { margin:0; padding:12px 12px 12px 16px; min-width:46px; text-align:right; color:var(--ac-foregroundMuted); font:inherit; font-family:var(--ac-code-font); line-height:1.7; overflow:hidden; user-select:none; }
.ac-root .ac-raw-editor textarea { flex:1; padding:12px; min-width:0; height:100%; border:0; border-radius:0; background:transparent; resize:none; font-family:var(--ac-code-font)!important; font-size:var(--ac-font-chrome); line-height:1.7; white-space:pre; }
.ac-settings { padding:8px 16px 16px; }
.ac-setting-number { width:110px; }
.ac-response[data-collapsed=true] { flex:0 0 auto; }
.ac-response[data-collapsed=true] > :not(.ac-response-head) { display:none; }
.ac-root[data-compact=true] .ac-authorization { grid-template-columns:1fr; }
.ac-root[data-compact=true] .ac-auth-type { border-right:0; border-bottom:1px solid var(--ac-border); }
.ac-root[data-compact=true] .ac-auth-fields { padding:16px; }
.ac-editor-split[data-columns=true] .ac-authorization { grid-template-columns:1fr; }
.ac-editor-split[data-columns=true] .ac-auth-type { border-right:0; border-bottom:1px solid var(--ac-border); }

.ac-library-context { display:flex; flex-direction:column; gap:6px; padding:12px; border-bottom:1px solid var(--ac-border); }
.ac-library-context select { width:100%; }
.ac-root[data-compact=true] .ac-side { top:0; }
.ac-url-frame [data-method=GET] { color:var(--ac-statusSuccess)!important; }
.ac-url-frame [data-method=POST] { color:var(--ac-statusWarning)!important; }
.ac-url-frame [data-method=PUT] { color:var(--ac-accent)!important; }
.ac-url-frame [data-method=PATCH] { color:var(--ac-accent)!important; }
.ac-url-frame [data-method=DELETE] { color:var(--ac-statusDanger)!important; }
.ac-url-frame [data-method=HEAD] { color:var(--ac-accent)!important; }
.ac-url-frame [data-method=OPTIONS] { color:var(--ac-statusWarning)!important; }
.ac-body-code { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; border-top:1px solid var(--ac-border); }
.ac-code-error { flex-shrink:0; padding:6px 16px; color:var(--ac-statusDanger); border-top:1px solid var(--ac-border); font-size:var(--ac-font-small); }
.ac-response-code { display:flex; flex-direction:column; overflow:hidden; padding:0; }
.ac-response-code > p { flex-shrink:0; padding:6px 16px; }

.ac-request-tabs { min-height:39px; padding:4px 6px; gap:4px; background:transparent; border:0; overflow:hidden; align-items:center; }
.ac-tabs-scroll { display:flex; align-items:center; gap:3px; min-width:0; flex:1; overflow:auto; scrollbar-width:none; }
.ac-tabs-scroll::-webkit-scrollbar { display:none; }
.ac-tabs-actions { display:flex; align-items:center; gap:2px; flex-shrink:0; padding-inline:2px; }
.ac-request-tab { height:29px; border:0; border-radius:var(--ac-radius); color:var(--ac-foregroundMuted); }
.ac-request-tab[data-active=true] { background:var(--ac-surface2); color:var(--ac-foreground); }
.ac-request-tab > button:first-child { padding:5px 9px; gap:7px; }
.ac-request-tab .ac-icon-button { width:22px; margin:0 2px 0 0; opacity:0; }
.ac-request-tab:hover .ac-icon-button,.ac-request-tab:focus-within .ac-icon-button,.ac-request-tab[data-active=true] .ac-icon-button { opacity:1; }
.ac-dirty-dot { width:5px; height:5px; flex-shrink:0; border-radius:50%; background:var(--ac-statusWarning); }
.ac-request-heading { min-height:40px; padding-block:5px; }
.ac-section-tabs { gap:3px; padding:2px 12px; min-height:35px; }
.ac-section-tabs button { padding:5px 8px; margin:2px 0; border:0; border-radius:var(--ac-radius); }
.ac-section-tabs button[aria-selected=true] { background:var(--ac-surface2); }
.ac-response-head { min-height:37px; }
.ac-status { padding:3px 7px; border-radius:var(--ac-radius); background:color-mix(in srgb,var(--ac-statusSuccess) 12%,transparent); }
.ac-status[data-error=true] { background:color-mix(in srgb,var(--ac-statusDanger) 12%,transparent); }
.ac-library-island { display:flex; flex-direction:column; width:310px; min-width:270px; max-width:40%; min-height:0; flex-shrink:0; }
.ac-side { flex:1; width:100%; min-width:0; max-width:none; border:0; background:transparent; overflow:hidden; }
.ac-library-rail { min-height:39px; display:flex; align-items:center; justify-content:space-between; padding:4px 8px; gap:6px; }
.ac-library-navigation { display:flex; align-items:center; gap:4px; }
.ac-library-navigation button { display:inline-flex; align-items:center; justify-content:center; width:32px; height:29px; background:transparent; border:0; border-radius:var(--ac-radius); color:var(--ac-foregroundMuted); }
.ac-library-navigation button:hover,.ac-library-navigation button[aria-selected=true] { background:var(--ac-surface2); color:var(--ac-foreground); }
.ac-library-context { flex-direction:row; align-items:center; gap:8px; padding:6px 12px 12px; color:var(--ac-foregroundMuted); border:0; }
.ac-library-context select { flex:1; }
.ac-side-search { position:relative; padding:4px 12px 8px; }
.ac-search-glyph { position:absolute; top:12px; left:21px; pointer-events:none; color:var(--ac-foregroundMuted); }
.ac-side-search input { padding-left:29px!important; background:transparent!important; }
.ac-side-toolbar { padding:4px 12px; min-height:30px; }
.ac-section-label { color:var(--ac-foregroundMuted); font-size:var(--ac-font-small); font-weight:500;  }
.ac-side-scroll { padding:2px 8px 12px; }
.ac-group { margin-bottom:8px; }
.ac-group-title { gap:3px; min-height:30px; }
.ac-group-title > .ac-icon-button:not(:first-child) { display:none; }
.ac-group-title:hover > .ac-icon-button,.ac-group-title:focus-within > .ac-icon-button { display:inline-flex; }
.ac-group-title > input { min-width:0; font-weight:400!important; }
.ac-group-requests { padding-left:16px; }
.ac-library-row { min-height:30px; }
.ac-library-row > button:first-child { padding:6px 8px; gap:7px; }
.ac-library-row .ac-method { min-width:37px; font-size:var(--ac-font-small); }
.ac-root[data-compact=true] .ac-library-island { position:absolute; z-index:20; inset:0 0 0 auto; width:min(340px,100%); max-width:100%; }
.ac-root[data-compact=true] .ac-side { position:static; width:100%; max-width:none; }
.ac-method-control { position:relative; display:flex; align-items:center; flex-shrink:0; }
.ac-method-control select { appearance:none; padding-right:30px!important; }
.ac-method-chevron { position:absolute; right:12px; pointer-events:none; color:var(--ac-foregroundMuted); font-size:17px; line-height:1; }
.ac-request-tabs { min-height:32px; padding:2px 4px; gap:2px; }
.ac-request-tab { height:26px; border-radius:4px; }
.ac-request-tab > button:first-child { padding:3px 6px; gap:5px; }
.ac-request-tab .ac-icon-button { width:18px; margin-right:1px; }
.ac-side-scroll { padding:0 4px 8px; }
.ac-collection-tree { margin-bottom:3px; }
.ac-tree-row { display:flex; align-items:center; min-height:24px; border-radius:4px; padding-left:calc(3px + var(--ac-tree-depth)*12px); }
.ac-tree-row:hover { background:var(--ac-surface2); }
.ac-tree-row[data-active=true] { background:var(--ac-surface2); }
.ac-tree-row > button { flex:1; display:flex; align-items:center; gap:5px; min-width:0; height:24px; padding:2px 4px; border:0; background:transparent; text-align:left; }
.ac-tree-row[data-kind=collection] > button { font-weight:500; }
.ac-tree-toggle-spacer { width:12px; flex-shrink:0; }
.ac-tree-row .ac-method { min-width:0; font-size:calc(var(--ac-font-small)*.85); font-weight:600; }
.ac-tree-actions { display:none; align-items:center; flex-shrink:0; }
.ac-tree-row:hover .ac-tree-actions,.ac-tree-row:focus-within .ac-tree-actions { display:flex; }
.ac-tree-actions .ac-icon-button { width:22px; height:22px; }
.ac-root input[type=checkbox],.ac-root input[type=radio] { color-scheme:inherit; accent-color:var(--ac-accent); }
.ac-tree-row[data-drop=true] { background:color-mix(in srgb,var(--ac-accent) 14%,transparent); outline:1px solid var(--ac-accent); outline-offset:-1px; }
.ac-tree-row[draggable=true] { cursor:grab; }
.ac-tree-row[data-dragging=true] { opacity:.5; }
.ac-tree-row[data-active=true] { background:color-mix(in srgb,var(--ac-accent) 12%,transparent); }
.ac-name-form { display:flex; flex-direction:column; gap:16px; }

.ac-variable-input { position:relative; min-width:0; width:100%; }
.ac-variable-input > input { width:100%; display:block; }
.ac-variable-input[data-highlight=true] > input { color:transparent!important; caret-color:var(--ac-foreground); }
.ac-variable-input input::selection { background:color-mix(in srgb,var(--ac-accent) 35%,transparent); }
.ac-variable-mirror { position:absolute; inset:1px; padding:6px 9px; overflow:hidden; pointer-events:none; font:inherit; color:var(--ac-foreground); line-height:inherit; }
.ac-variable-text { white-space:pre; width:max-content; }
.ac-variable-trigger { pointer-events:auto; color:var(--ac-variable-set); background:color-mix(in srgb,var(--ac-variable-set) 12%,transparent); border-radius:2px; }
.ac-variable-trigger[data-resolved=false] { color:var(--ac-statusDanger); background:color-mix(in srgb,var(--ac-statusDanger) 15%,transparent); }
.ac-variable-trigger > div { display:inline!important; color:inherit!important; }
.ac-variable-trigger > div span { color:inherit!important; }
.ac-variable-quick-edit { position:fixed; z-index:100; top:120px; right:24px; width:300px; height:auto; padding:12px; border:1px solid var(--ac-border); border-radius:6px; background:var(--ac-surface1); }
.ac-variable-footer { display:flex; align-items:center; gap:7px; }
.ac-variable-scope-icon { background:color-mix(in srgb,var(--ac-statusSuccess) 18%,transparent); color:var(--ac-statusSuccess); border-radius:4px; padding:1px 5px; font-weight:500; }
.ac-root .ac-variable-footer select { border:0; background:transparent; padding:2px 0; color:var(--ac-foregroundMuted); flex:1; }
.ac-variable-preview > .ac-inline > input { flex:1; width:100%; min-width:0; background:transparent; border:1px solid var(--ac-border); border-radius:6px; padding:8px 9px; }
.ac-variable-scope-label { flex:1; color:var(--ac-foregroundMuted); }
.ac-variable-request-link { border:0; padding:0; background:transparent; color:var(--ac-foregroundMuted)!important; white-space:nowrap; }
.ac-variable-request-link:hover { color:var(--ac-foreground)!important; }
.ac-variable-preview { height:auto; width:340px; padding:12px; gap:8px; overflow:visible; background:transparent; }
.ac-variable-preview code { white-space:pre-wrap; overflow-wrap:anywhere; max-height:120px; overflow:auto; font-family:var(--ac-code-font); }
.ac-variable-error { color:var(--ac-statusDanger); }

/* Keep the request builder dense so the response stays visible while editing. */
.ac-request-heading { min-height:32px; padding:3px 12px; gap:8px; }
.ac-request-heading .ac-request-identity { gap:6px; }
.ac-request-bar { padding:0 12px 8px; gap:6px; }
.ac-url-frame { min-height:32px; border-radius:5px; }
.ac-url-frame select { width:78px; }
.ac-url-frame input { padding:5px 9px!important; }
.ac-url-frame .ac-variable-mirror { padding:5px 9px; }
.ac-request-tabs { min-height:29px; }
.ac-section-tabs { min-height:30px; padding:1px 10px; }
.ac-section-tabs button { padding:4px 7px; margin:1px 0; }
.ac-editor-content { padding:10px 12px; }
.ac-pair-heading { min-height:26px; }
.ac-pair-heading > span { padding:3px 7px; }
.ac-pair-row { min-height:29px; }
.ac-root .ac-pair-row input:not([type=checkbox]):not([type=file]) { padding:5px 7px; }
.ac-pair-value { gap:2px; }
.ac-pair-editor > .ac-action { margin-top:5px; }
.ac-response-head { min-height:32px; padding-inline:12px; gap:8px; }
.ac-response-tools { padding:6px 12px; gap:6px; }
.ac-response-body { padding:4px 12px 10px; }
.ac-response-body pre { line-height:1.5; }
.ac-response-table td { padding:5px 7px; }
.ac-body-toolbar { gap:10px; padding:8px 12px; }
.ac-body-fields { padding:0 12px 10px; }
.ac-auth-type { padding:12px; }
.ac-auth-fields { padding:12px 16px; gap:10px; }
.ac-settings { padding:6px 12px 12px; }
.ac-headers-toolbar { gap:8px; margin-bottom:6px; }
.ac-variable-status { padding:0 12px 4px; }
.ac-resize-handle { height:5px; }
.ac-main[data-editing-environment=true] > .ac-request-heading,.ac-main[data-editing-environment=true] > .ac-request-bar { display:none; }
.ac-environment-workspace { flex:1; min-height:0; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:12px; }
.ac-environment-picker { position:relative; min-width:0; }
.ac-environment-trigger { display:flex; align-items:center; gap:8px; min-width:138px; max-width:220px; height:29px; padding:4px 9px; border:1px solid var(--ac-border); border-radius:5px; background:var(--ac-surface1); text-align:left; }
.ac-environment-trigger:hover { background:var(--ac-surface2); }
.ac-environment-trigger > span:first-child { flex:1; }
.ac-environment-menu { position:absolute; z-index:50; top:calc(100% + 6px); right:0; width:min(420px, calc(100vw - 32px)); max-height:min(520px, calc(100vh - 80px)); display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--ac-border); border-radius:8px; background:var(--ac-surface1); box-shadow:0 12px 32px rgb(0 0 0 / 35%); }
.ac-root .ac-environment-search { flex-shrink:0; margin:6px; width:calc(100% - 12px); padding:8px 10px; border:0; border-bottom:1px solid var(--ac-border); border-radius:4px 4px 0 0; background:transparent; }
.ac-environment-options { min-height:0; overflow:auto; padding:2px 5px 6px; }
.ac-environment-option { display:flex; align-items:center; gap:8px; width:100%; min-height:32px; padding:5px 8px; border:0; border-radius:5px; background:transparent; text-align:left; }
.ac-environment-option:hover,.ac-environment-option[aria-selected=true] { background:var(--ac-surface2); }
.ac-environment-check { display:flex; align-items:center; justify-content:center; width:18px; flex-shrink:0; color:var(--ac-foregroundMuted); }
.ac-environment-option[aria-selected=true] .ac-environment-check { color:var(--ac-foreground); }
.ac-environment-empty { padding:12px 34px; color:var(--ac-foregroundMuted); }
.ac-environment-create { display:flex; align-items:center; gap:9px; min-height:38px; flex-shrink:0; padding:6px 12px; border:0; border-top:1px solid var(--ac-border); background:transparent; text-align:left; }
.ac-environment-create:hover { background:var(--ac-surface2); }
.ac-variable-status { display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:0 16px 6px; font-size:var(--ac-font-small); color:var(--ac-statusDanger); }
.ac-url-frame .ac-variable-input { flex:1; font-family:var(--ac-code-font); }
.ac-url-frame .ac-variable-mirror { inset:0; padding:8px 12px; }
.ac-pair-row .ac-variable-mirror { inset:0; padding:8px 9px; }
.ac-auth-fields .ac-variable-input { max-width:460px; }
.ac-root .cm-variable-resolved { color:var(--ac-variable-set)!important; background:color-mix(in srgb,var(--ac-variable-set) 12%,transparent); }
.ac-root .cm-variable-missing { color:var(--ac-statusDanger)!important; background:color-mix(in srgb,var(--ac-statusDanger) 15%,transparent); }
.ac-code-variable-tooltip { display:flex; flex-direction:column; gap:6px; padding:10px; }
.ac-code-variable-tooltip button { background:var(--ac-surface2); border:1px solid var(--ac-border); border-radius:4px; padding:4px 8px; }
`;
