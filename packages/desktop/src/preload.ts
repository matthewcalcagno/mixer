import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";
import type { StatusBarMenuRequest, StatusBarMenuResult } from "./features/status-bar-menu.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.mixerDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with MIXER_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const MIXER_BROWSER_PROFILE_PARTITION = "persist:mixer-browser";

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--mixer-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

contextBridge.exposeInMainWorld("mixerDesktop", {
  platform: process.platform,
  windowChromeMode: readWindowChromeMode(),
  startup: { ready: () => ipcRenderer.invoke("mixer:window:startup-ready") as Promise<void> },
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("mixer:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("mixer:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("mixer:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`mixer:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`mixer:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("mixer:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("mixer:window:minimize"),
      close: () => ipcRenderer.invoke("mixer:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("mixer:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("mixer:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("mixer:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("mixer:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("mixer:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("mixer:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("mixer:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("mixer:window:setBadgeCount", count),
    }),
  },
  dialog: {
    saveText: (options: { content: string; defaultPath?: string }) =>
      ipcRenderer.invoke("mixer:dialog:saveText", options) as Promise<string | null>,
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("mixer:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("mixer:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("mixer:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("mixer:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("mixer:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("mixer:opener:openUrl", url),
  },
  editor: {
    listTargets: (input?: { workspacePath?: string }) =>
      ipcRenderer.invoke("mixer:editor:listTargets", input),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("mixer:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showStatusBarMenu: (input: StatusBarMenuRequest): Promise<StatusBarMenuResult | null> =>
      ipcRenderer.invoke("mixer:menu:status-bar", input),
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("mixer:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("mixer:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("mixer:browser:set-shortcut-policy", input),
    profilePartition: MIXER_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("mixer:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("mixer:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("mixer:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("mixer:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("mixer:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("mixer:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("mixer:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("mixer:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("mixer:browser:copy-element", payload),
  },
});
