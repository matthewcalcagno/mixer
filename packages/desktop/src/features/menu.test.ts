import { describe, expect, it } from "vitest";
import { reloadActiveBrowserOrWindow } from "./menu.js";
import { actionContextMenuSchema, actionContextMenuTemplate } from "./action-context-menu.js";
import {
  statusBarMenuSchema,
  statusBarMenuTemplate,
  type StatusBarMenuResult,
} from "./status-bar-menu.js";

describe("native resource context menus", () => {
  it("builds nested OS submenus and displays shortcuts without registering duplicate bindings", () => {
    const selected: string[] = [];
    const input = actionContextMenuSchema.parse({
      kind: "actions",
      items: [
        {
          id: "project",
          label: "Project",
          submenu: [
            {
              id: "more",
              label: "More",
              submenu: [
                {
                  id: "delete",
                  label: "Delete",
                  accelerator: "Command+Shift+Backspace",
                  role: "quit",
                },
              ],
            },
          ],
        },
      ],
    });
    const first = actionContextMenuTemplate(input, (id) => selected.push(id))[0].submenu;
    if (!Array.isArray(first) || !Array.isArray(first[0].submenu))
      throw new Error("Missing nested native submenu");
    const action = first[0].submenu[0];
    expect(action).toMatchObject({
      label: "Delete",
      accelerator: "Command+Shift+Backspace",
      registerAccelerator: false,
    });
    expect(action.role).toBeUndefined();
    if (!action.click) throw new Error("Missing native action");
    Reflect.apply(action.click, undefined, []);
    expect(selected).toEqual(["delete"]);
  });

  it("rejects cyclic and excessive nested IPC before recursive parsing", () => {
    const items: Array<{ id: string; label: string; submenu?: unknown }> = [];
    items.push({ id: "cycle", label: "Cycle", submenu: items });
    expect(actionContextMenuSchema.safeParse({ kind: "actions", items }).success).toBe(false);
    let nested: { id: string; label: string; submenu?: unknown } = { id: "leaf", label: "Leaf" };
    for (let depth = 0; depth < 12; depth++)
      nested = { id: `depth-${depth}`, label: "Nested", submenu: [nested] };
    expect(actionContextMenuSchema.safeParse({ kind: "actions", items: [nested] }).success).toBe(
      false,
    );
  });
  it("preserves a workspace label catalog larger than fifty choices", () => {
    const selected: string[] = [];
    const input = actionContextMenuSchema.parse({
      kind: "actions",
      items: [
        {
          id: "labels",
          label: "Labels",
          submenu: Array.from({ length: 60 }, (_, index) => ({
            id: `label-${index}`,
            label: `Label ${index}`,
            checked: index === 0,
          })),
        },
      ],
    });
    const submenu = actionContextMenuTemplate(input, (id) => selected.push(id))[0].submenu;
    if (!Array.isArray(submenu)) throw new Error("Missing native Labels submenu");
    expect(submenu).toHaveLength(60);
    expect(submenu[0]).toMatchObject({ label: "Label 0", type: "checkbox", checked: true });
    expect(submenu[59]).toMatchObject({ label: "Label 59", type: "checkbox", checked: false });
    if (!submenu[59].click) throw new Error("Missing label action");
    Reflect.apply(submenu[59].click, undefined, []);
    expect(selected).toEqual(["label-59"]);
  });
  it("preserves checked Open with choices and separators in native tab submenus", () => {
    const selected: string[] = [];
    const input = actionContextMenuSchema.parse({
      kind: "actions",
      items: [
        {
          id: "open-with",
          label: "Open with",
          submenu: [
            { id: "source", label: "Source", checked: true, role: "quit" },
            { id: "preview", label: "Preview", checked: false },
            { id: "always", label: "Always use", checked: false, separatorBefore: true },
          ],
        },
      ],
    });
    const template = actionContextMenuTemplate(input, (id) => selected.push(id));
    const submenu = template[0].submenu;
    if (!Array.isArray(submenu)) throw new Error("Missing native submenu template");
    expect(
      submenu.map((item) => ({
        label: item.label,
        type: item.type,
        checked: item.checked,
        role: item.role,
      })),
    ).toEqual([
      { label: "Source", type: "checkbox", checked: true, role: undefined },
      { label: "Preview", type: "checkbox", checked: false, role: undefined },
      { label: undefined, type: "separator", checked: undefined, role: undefined },
      { label: "Always use", type: "checkbox", checked: false, role: undefined },
    ]);
    const click = submenu[1].click;
    if (!click) throw new Error("Missing submenu action");
    Reflect.apply(click, undefined, []);
    expect(selected).toEqual(["preview"]);
    expect(() =>
      actionContextMenuSchema.parse({
        kind: "actions",
        items: [
          { id: "duplicate", label: "Open with", submenu: [{ id: "duplicate", label: "Source" }] },
        ],
      }),
    ).toThrow("Duplicate context action IDs");
  });
  it("builds ordinary native actions and ignores renderer roles and callbacks", () => {
    const selected: string[] = [];
    const input = actionContextMenuSchema.parse({
      kind: "actions",
      items: [
        { id: "open", label: "Open Changes", role: "quit" },
        { id: "stage", label: "Stage 2 Changes", click: "untrusted" },
        { id: "discard", label: "Discard Changes…", disabled: true, separatorBefore: true },
      ],
    });
    const template = actionContextMenuTemplate(input, (id) => selected.push(id));
    expect(
      template.map((item) => ({
        label: item.label,
        type: item.type,
        enabled: item.enabled,
        role: item.role,
      })),
    ).toEqual([
      { label: "Open Changes", type: undefined, enabled: true, role: undefined },
      { label: "Stage 2 Changes", type: undefined, enabled: true, role: undefined },
      { label: undefined, type: "separator", enabled: undefined, role: undefined },
      { label: "Discard Changes…", type: undefined, enabled: false, role: undefined },
    ]);
    for (const index of [0, 1, 3]) {
      const callback = template[index].click;
      if (!callback) throw new Error("Missing context action callback");
      Reflect.apply(callback, undefined, []);
    }
    expect(selected).toEqual(["open", "stage"]);
  });
  it("rejects duplicate IDs, empty menus, and oversized payloads", () => {
    expect(() => actionContextMenuSchema.parse({ kind: "actions", items: [] })).toThrow();
    expect(() =>
      actionContextMenuSchema.parse({
        kind: "actions",
        items: [
          { id: "stage", label: "Stage" },
          { id: "stage", label: "Unstage" },
        ],
      }),
    ).toThrow("Duplicate context action IDs");
    expect(() =>
      actionContextMenuSchema.parse({
        kind: "actions",
        items: [{ id: "stage", label: "x".repeat(257) }],
      }),
    ).toThrow();
  });
});

describe("native status bar visibility menu", () => {
  it("builds native checkbox entries and returns only known visibility operations", () => {
    const actions: StatusBarMenuResult[] = [];
    const input = statusBarMenuSchema.parse({
      hideLabel: "Hide Status Bar",
      items: [
        { id: "builtin:git-branch", label: "Current branch", checked: true },
        { id: "plugin:test:info", label: "Plugin status", checked: false, role: "quit" },
      ],
    });
    const template = statusBarMenuTemplate(input, (action) => actions.push(action));
    expect(
      template.map((item) => ({ label: item.label, type: item.type, checked: item.checked })),
    ).toEqual([
      { label: "Current branch", type: "checkbox", checked: true },
      { label: "Plugin status", type: "checkbox", checked: false },
    ]);
    expect(template[1].role).toBeUndefined();
    for (const index of [0, 1]) {
      const callback = template[index].click;
      if (!callback) throw new Error("Missing native menu callback");
      Reflect.apply(callback, undefined, []);
    }
    expect(actions).toEqual([
      { kind: "toggle-item", id: "builtin:git-branch", visible: false },
      { kind: "toggle-item", id: "plugin:test:info", visible: true },
    ]);
  });
  it("rejects malformed or duplicate menu payloads", () => {
    expect(() =>
      statusBarMenuSchema.parse({
        hideLabel: "Hide",
        items: [{ id: "one", label: "One", checked: "yes" }],
      }),
    ).toThrow();
    expect(() =>
      statusBarMenuSchema.parse({
        hideLabel: "Hide",
        items: [
          { id: "one", label: "One", checked: true },
          { id: "one", label: "Two", checked: false },
        ],
      }),
    ).toThrow("Duplicate status item IDs");
  });
  it("keeps an empty bar's menu empty without a hide-bar action", () => {
    expect(statusBarMenuTemplate(statusBarMenuSchema.parse({ items: [] }), () => {})).toEqual([]);
  });
});

class FakeWebContents {
  public readonly reloads: string[] = [];

  public constructor(public readonly id: number) {}

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }
}

class BrowserReloads {
  public readonly firstWindow = { webContents: new FakeWebContents(101) };
  public readonly secondWindow = { webContents: new FakeWebContents(202) };
  public readonly firstBrowser = new FakeWebContents(11);
  public readonly secondBrowser = new FakeWebContents(22);
  public readonly resolvedHostWindowIds: number[] = [];

  public activeBrowserForHostWindow(hostWebContentsId: number): FakeWebContents | null {
    this.resolvedHostWindowIds.push(hostWebContentsId);
    return hostWebContentsId === 101 ? this.firstBrowser : this.secondBrowser;
  }
}

describe("reloadActiveBrowserOrWindow", () => {
  it("reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.firstWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([101]);
    expect(browserReloads.firstBrowser.reloads).toEqual(["reload"]);
    expect(browserReloads.secondBrowser.reloads).toEqual([]);
    expect(browserReloads.firstWindow.webContents.reloads).toEqual([]);
  });

  it("force reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.secondWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
      ignoreCache: true,
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([202]);
    expect(browserReloads.firstBrowser.reloads).toEqual([]);
    expect(browserReloads.secondBrowser.reloads).toEqual(["force-reload"]);
    expect(browserReloads.secondWindow.webContents.reloads).toEqual([]);
  });
});
