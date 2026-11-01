import { createContext, useContext, useId, useLayoutEffect, type RefObject } from "react";
import type { ActionContextMenuRequest } from "../../../../../desktop/src/features/action-context-menu";

interface NativeEntryBase {
  id: string;
  pageId: string | null;
  node: RefObject<unknown>;
  label?: RefObject<unknown>;
  text?: string;
}
type NativeEntry = NativeEntryBase &
  (
    | { kind: "action"; disabled: boolean; checked?: boolean; onSelect?: () => unknown }
    | { kind: "submenu"; disabled: boolean; target: string }
    | { kind: "separator" | "label" }
  );
export interface NativePage {
  id: string;
  form: boolean;
  title?: string;
  node?: RefObject<unknown>;
}
export interface NativeMenuSnapshot {
  items: ActionContextMenuRequest["items"];
  actions: ReadonlyMap<string, () => unknown>;
  forms: ReadonlyMap<string, { path: string[]; title: string }>;
}
export function nativeMenuHasControls(node: unknown): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (
    node.querySelector(
      "input,textarea,select,[contenteditable='true'],[role='textbox'],[role='switch'],[role='slider']",
    )
  )
    return true;
  return [...node.querySelectorAll("button,[role='button'],a[href]")].some(
    (element) => !element.closest("[data-menu-item='true']"),
  );
}
function domNode(ref: RefObject<unknown>): Node | null {
  return ref.current instanceof Node ? ref.current : null;
}
function labelText(entry: NativeEntry): string {
  const text = entry.text ?? domNode(entry.label ?? entry.node)?.textContent?.trim() ?? "";
  if (text.length <= 256) return text;
  return text.slice(0, 255).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
function readNativeAccelerator(ref: RefObject<unknown>): string | undefined {
  const node = domNode(ref);
  if (!(node instanceof HTMLElement)) return undefined;
  return (
    node.querySelector("[data-electron-accelerator]")?.getAttribute("data-electron-accelerator") ??
    undefined
  );
}

/** Each open menu owns its registrations; callbacks never cross desktop IPC. */
export class NativeMenuRegistry {
  private entries = new Map<string, NativeEntry>();
  private resources = new Set<string>();
  pending(): boolean {
    return this.resources.size > 0;
  }
  resource(id: string, pending: boolean): () => void {
    if (pending) this.resources.add(id);
    else this.resources.delete(id);
    return () => {
      this.resources.delete(id);
    };
  }
  register(entry: NativeEntry): () => void {
    this.entries.set(entry.id, entry);
    return () => {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    };
  }
  snapshot(pages: readonly NativePage[], root?: RefObject<unknown>): NativeMenuSnapshot {
    const actions = new Map<string, () => unknown>();
    const forms = new Map<string, { path: string[]; title: string }>();
    const pageMap = new Map(pages.map((page) => [page.id, page]));
    const entries = [...this.entries.values()].filter((entry) => domNode(entry.node));
    // Preserve warnings and captions authored outside MenuLabel/MenuHint as native disabled rows.
    const roots = [{ id: null, node: root }, ...pages];
    let noteId = 0;
    for (const page of roots) {
      const container = page.node && domNode(page.node);
      if (!(container instanceof HTMLElement)) continue;
      const owned = entries
        .filter((entry) => entry.pageId === page.id)
        .flatMap((entry) => {
          const node = domNode(entry.node);
          return node ? [node] : [];
        });
      const blocks = new Map<Node, string[]>();
      const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (!text || owned.some((owner) => owner.contains(node))) continue;
        let block: Node = node;
        for (
          let parent = node.parentElement;
          parent && parent !== container && !owned.some((owner) => parent?.contains(owner));
          parent = parent.parentElement
        )
          block = parent;
        const texts = blocks.get(block) ?? [];
        texts.push(text);
        blocks.set(block, texts);
      }
      for (const [node, texts] of blocks)
        entries.push({
          id: `native-note-${noteId++}`,
          pageId: page.id,
          kind: "label",
          node: { current: node },
          text: texts.join(" "),
        });
    }
    entries.sort((left, right) => {
      const a = domNode(left.node),
        b = domNode(right.node);
      if (!a || !b || a === b) return 0;
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    function makeEntry(
      entry: NativeEntry,
      path: string[],
      separatorBefore: boolean,
    ): ActionContextMenuRequest["items"][number] | null {
      const label = labelText(entry);
      if (!label) return null;
      const common = { id: entry.id, label, separatorBefore };
      if (entry.kind === "action") {
        if (!entry.disabled && entry.onSelect) actions.set(entry.id, entry.onSelect);
        const accelerator = readNativeAccelerator(entry.node);
        return { ...common, disabled: entry.disabled, checked: entry.checked, accelerator };
      }
      if (entry.kind !== "submenu") return { ...common, disabled: true };
      const page = pageMap.get(entry.target);
      const nextPath = [...path, entry.target];
      if (page && (page.form || nativeMenuHasControls(page.node?.current))) {
        if (!entry.disabled) forms.set(entry.id, { path: nextPath, title: page.title ?? label });
        return { ...common, disabled: entry.disabled };
      }
      const submenu = page ? build(entry.target, nextPath) : [];
      if (submenu.length > 1000) {
        if (!entry.disabled) forms.set(entry.id, { path: nextPath, title: page?.title ?? label });
        return { ...common, disabled: entry.disabled };
      }
      if (!submenu.length) return { ...common, disabled: true };
      return { ...common, disabled: entry.disabled, submenu };
    }
    function build(pageId: string | null, path: string[]): ActionContextMenuRequest["items"] {
      if (path.length > 8 || new Set(path).size !== path.length)
        throw new Error("Invalid native submenu navigation");
      const items: ActionContextMenuRequest["items"] = [];
      let separator = false;
      for (const entry of entries.filter((candidate) => candidate.pageId === pageId)) {
        if (entry.kind === "separator") {
          separator = true;
          continue;
        }
        const item = makeEntry(entry, path, separator && items.length > 0);
        if (!item) continue;
        items.push(item);
        separator = false;
      }
      return items;
    }
    const items = build(null, []);
    const allowed = new Set<string>();
    const collect = (rows: typeof items) => {
      for (const row of rows) {
        if (row.disabled) continue;
        if (row.submenu) collect(row.submenu);
        else allowed.add(row.id);
      }
    };
    collect(items);
    return {
      items,
      actions: new Map([...actions].filter(([id]) => allowed.has(id))),
      forms: new Map([...forms].filter(([id]) => allowed.has(id))),
    };
  }
}
const NativeRegistryContext = createContext<NativeMenuRegistry | null>(null);
const NativePageContext = createContext<string | null>(null);
export const NativeRegistryProvider = NativeRegistryContext.Provider;
export const NativePageProvider = NativePageContext.Provider;
export function useNativeMenuCapture(): boolean {
  return useContext(NativeRegistryContext) !== null;
}

type EntryInput = Omit<NativeEntryBase, "id" | "pageId"> &
  (
    | { kind: "action"; disabled: boolean; checked?: boolean; onSelect?: () => unknown }
    | { kind: "submenu"; disabled: boolean; target: string }
    | { kind: "separator" | "label" }
  );
export function useNativeMenuEntry(input: EntryInput): void {
  const registry = useContext(NativeRegistryContext);
  const pageId = useContext(NativePageContext);
  const id = useId();
  useLayoutEffect(
    () => registry?.register({ ...input, id, pageId }),
    [registry, input, id, pageId],
  );
}
export function useNativeMenuItem(input: {
  node: RefObject<unknown>;
  label: RefObject<unknown>;
  disabled: boolean;
  checked?: boolean;
  onSelect?: () => unknown;
  submenu?: string;
}): void {
  useNativeMenuEntry(
    input.submenu
      ? {
          kind: "submenu",
          target: input.submenu,
          disabled: input.disabled,
          node: input.node,
          label: input.label,
        }
      : {
          kind: "action",
          disabled: input.disabled,
          checked: input.checked,
          onSelect: input.onSelect,
          node: input.node,
          label: input.label,
        },
  );
}
export function useNativeMenuResource(pending: boolean): void {
  const registry = useContext(NativeRegistryContext);
  const id = useId();
  useLayoutEffect(() => registry?.resource(id, pending), [registry, pending, id]);
}
