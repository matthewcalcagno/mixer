import { app, Menu, BrowserWindow, ipcMain } from "electron";
import { getActiveMixerBrowserWebContentsForHostWindow } from "./browser-webviews/index.js";
import {
  statusBarMenuSchema,
  statusBarMenuTemplate,
  type StatusBarMenuResult,
} from "./status-bar-menu.js";
import { actionContextMenuSchema, actionContextMenuTemplate } from "./action-context-menu.js";

interface ShowContextMenuInput {
  kind?: "terminal";
  hasSelection?: boolean;
}

interface ApplicationMenuOptions {
  onNewWindow: () => void;
}

function withBrowserWindow(
  callback: (win: BrowserWindow) => void,
): (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => void {
  return (_item, baseWin) => {
    const win = baseWin instanceof BrowserWindow ? baseWin : BrowserWindow.getFocusedWindow();
    if (win) callback(win);
  };
}

interface ReloadableWebContents {
  isLoadingMainFrame(): boolean;
  stop(): void;
  reload(): void;
  reloadIgnoringCache(): void;
}

interface ReloadableWindow {
  webContents: ReloadableWebContents & { id: number };
}

interface ReloadActiveBrowserOrWindowInput {
  win: ReloadableWindow;
  getActiveBrowserContentsForHostWindow: (
    hostWebContentsId: number,
  ) => ReloadableWebContents | null;
  ignoreCache?: boolean;
}

export function reloadActiveBrowserOrWindow({
  win,
  getActiveBrowserContentsForHostWindow,
  ignoreCache = false,
}: ReloadActiveBrowserOrWindowInput): void {
  const browserContents = getActiveBrowserContentsForHostWindow(win.webContents.id);
  if (browserContents) {
    if (ignoreCache) {
      browserContents.reloadIgnoringCache();
      return;
    }
    if (browserContents.isLoadingMainFrame()) {
      browserContents.stop();
      return;
    }
    browserContents.reload();
    return;
  }

  if (ignoreCache) {
    win.webContents.reloadIgnoringCache();
    return;
  }
  win.webContents.reload();
}

function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
  capturing: boolean,
): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  const zoomEnabled = !capturing;

  const helpWindow = BrowserWindow.getFocusedWindow();
  const helpMenu = helpWindow ? applicationHelpMenus.get(helpWindow.webContents.id) : undefined;

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            options.onNewWindow();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
          }),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
          }),
        },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(0);
          }),
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActiveMixerBrowserWebContentsForHostWindow,
            });
          }),
        },
        {
          label: "Force Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActiveMixerBrowserWebContentsForHostWindow,
              ignoreCache: true,
            });
          }),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      role: "help",
      submenu:
        helpMenu && helpWindow
          ? actionContextMenuTemplate(helpMenu, (id) => {
              if (!helpWindow.isDestroyed()) {
                helpWindow.webContents.send("mixer:event:help-menu-action", id);
              }
            })
          : [],
    },
  ];
}

const applicationHelpMenus = new Map<number, ReturnType<typeof actionContextMenuSchema.parse>>();
let applicationMenuOptions: ApplicationMenuOptions | null = null;
let capturingShortcut = false;

function rebuildApplicationMenu(): void {
  if (!applicationMenuOptions) return;
  const menu = Menu.buildFromTemplate(
    buildApplicationMenuTemplate(applicationMenuOptions, capturingShortcut),
  );
  Menu.setApplicationMenu(menu);
}

export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  applicationMenuOptions = options;
  rebuildApplicationMenu();
  ipcMain.handle("mixer:menu:set-help", (event, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (raw === null) applicationHelpMenus.delete(event.sender.id);
    else applicationHelpMenus.set(event.sender.id, actionContextMenuSchema.parse(raw));
    rebuildApplicationMenu();
  });
  // The application menu is shared by all windows; actions belong to the focused renderer.
  app.on("browser-window-focus", () => rebuildApplicationMenu());
  ipcMain.handle(
    "mixer:menu:status-bar",
    (event, raw: unknown): Promise<StatusBarMenuResult | null> => {
      const input = statusBarMenuSchema.parse(raw);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return Promise.resolve(null);
      return new Promise((resolve) => {
        let selection: StatusBarMenuResult | null = null;
        const menu = Menu.buildFromTemplate(
          statusBarMenuTemplate(input, (result) => {
            selection = result;
          }),
        );
        menu.popup({ window: win, callback: () => resolve(selection) });
      });
    },
  );

  ipcMain.handle(
    "mixer:menu:showContextMenu",
    (event, raw?: ShowContextMenuInput | { kind: "actions" }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        return undefined;
      }

      if (raw?.kind === "actions") {
        const input = actionContextMenuSchema.parse(raw);
        return new Promise<string | null>((resolve) => {
          let selection: string | null = null;
          const menu = Menu.buildFromTemplate(
            actionContextMenuTemplate(input, (id) => {
              selection = id;
            }),
          );
          menu.popup({ window: win, callback: () => resolve(selection) });
        });
      }
      if (raw?.kind !== "terminal") {
        return undefined;
      }

      const contextMenu = Menu.buildFromTemplate([
        {
          label: "Copy",
          role: "copy",
          enabled: raw.hasSelection === true,
        },
        {
          label: "Paste",
          role: "paste",
        },
        {
          type: "separator",
        },
        {
          label: "Select All",
          role: "selectAll",
        },
      ]);

      contextMenu.popup({ window: win });
      return undefined;
    },
  );

  // Disable the zoom accelerators while capturing a shortcut so combos like
  // Cmd+- / Cmd+= reach the renderer instead of zooming the window.
  ipcMain.handle("mixer:menu:set-capturing-shortcut", (_event, capturing?: boolean) => {
    capturingShortcut = capturing === true;
    rebuildApplicationMenu();
  });

  // If the renderer reloads mid-capture (e.g. Cmd+R) the renderer-side effect
  // never gets to send `false`, so reset the flag from the main process when a
  // main window finishes loading. Workspace browser webviews are not
  // BrowserWindows, so they don't trigger this.
  app.on("browser-window-created", (_event, win) => {
    const webContentsId = win.webContents.id;
    win.webContents.on("destroyed", () => {
      applicationHelpMenus.delete(webContentsId);
      rebuildApplicationMenu();
    });
    win.webContents.on("did-start-navigation", (_navigationEvent, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      applicationHelpMenus.delete(webContentsId);
      rebuildApplicationMenu();
    });
    win.webContents.on("did-finish-load", () => {
      if (!capturingShortcut) return;
      capturingShortcut = false;
      rebuildApplicationMenu();
    });
  });
}
