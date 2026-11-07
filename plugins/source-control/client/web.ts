import { Linking, Platform, Text, View } from "react-native";
import { createElement, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { PluginTheme, RpcOutput } from "@mixer/plugin";
import { useEditorSyntaxOptions, confirmDialog } from "@mixer/plugin/client/ui";
import type { documentRpc } from "../shared/git.js";
import { diffSelection, type DiffSelection } from "./diff-selection.js";
import { diffTabSchema, type DiffTab } from "../shared/diff-tabs.js";
import { editorHtml } from "./generated/editor-html.js";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface FrameWindow {
  postMessage(message: unknown, origin: string): void;
}
interface FrameNode {
  contentWindow: FrameWindow | null;
}
interface FrameMessage {
  source: unknown;
  data: unknown;
}

export function commitMessagePlaceholder(branch: string): string {
  return branch && branch !== "HEAD" ? `Commit message for "${branch}"` : "Commit message";
}

export function resizeCommitInput(input: unknown): number | null {
  if (
    Platform.OS !== "web" ||
    !input ||
    typeof input !== "object" ||
    !("style" in input) ||
    !("scrollHeight" in input)
  )
    return null;
  if (
    !input.style ||
    typeof input.style !== "object" ||
    !("height" in input.style) ||
    typeof input.scrollHeight !== "number"
  )
    return null;
  input.style.height = "0px";
  const height = Math.min(140, Math.max(28, input.scrollHeight));
  input.style.height = `${height}px`;
  return height;
}
declare const window: {
  open(url: string, target: string, features: string): unknown;
  confirm(message: string): boolean;
  addEventListener(type: "message", listener: (event: FrameMessage) => void): void;
  removeEventListener(type: "message", listener: (event: FrameMessage) => void): void;
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
};

const diffStorageKey = "source-control.diff-panels.v1";
const tabStorageKey = "source-control.diff-tabs.v1";
export function rememberedDiffTabs(): DiffTab[] {
  if (Platform.OS !== "web") return [];
  try {
    const parsed = z
      .array(diffTabSchema)
      .max(200)
      .safeParse(JSON.parse(window.localStorage.getItem(tabStorageKey) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function rememberedDiffs(): DiffSelection[] {
  if (Platform.OS !== "web") return [];
  try {
    const parsed = z
      .array(diffSelection)
      .max(200)
      .safeParse(JSON.parse(window.localStorage.getItem(diffStorageKey) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function rememberDiff(selection: DiffSelection) {
  if (Platform.OS !== "web") return;
  try {
    const entries = rememberedDiffs().filter(
      (entry) => entry.path !== selection.path || entry.staged !== selection.staged,
    );
    window.localStorage.setItem(
      diffStorageKey,
      JSON.stringify([...entries, selection].slice(-200)),
    );
  } catch {
    /* Storage restrictions must not prevent opening a file. */
  }
}

const editorEvent = z.discriminatedUnion("type", [
  z.object({
    source: z.literal("source-control-monaco"),
    type: z.literal("error"),
    message: z.string(),
  }),
  z.object({
    source: z.literal("source-control-monaco"),
    type: z.enum(["ready", "mounted", "pin"]),
  }),
  z.object({
    source: z.literal("source-control-monaco"),
    type: z.literal("changed"),
    content: z.string(),
  }),
  z.object({
    source: z.literal("source-control-monaco"),
    type: z.literal("save"),
    content: z.string(),
    revision: z.string(),
  }),
]);

export interface MonacoHandle {
  saved(revision: string): void;
  saveFailed(): void;
}
function editorAppearance(theme: PluginTheme) {
  const c = theme.colors;
  const hex = c.surface0.replace("#", "");
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return {
    light: (red * 299 + green * 587 + blue * 114) / 1000 > 150,
    background: c.surface0,
    foreground: c.foreground,
    muted: c.foregroundMuted,
    border: c.border,
  };
}
export function MonacoDiffEditor(props: {
  path: string;
  data: RpcOutput<typeof documentRpc>;
  theme: PluginTheme;
  dirty: boolean;
  onChange(content: string): void;
  onSave(content: string, revision: string): void;
  onKeepOpen(): void;
  editorRef: { current: MonacoHandle | null };
}) {
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const syntaxOptions = useEditorSyntaxOptions();
  const syntaxOptionsRef = useRef(syntaxOptions);
  syntaxOptionsRef.current = syntaxOptions;
  const frame = useRef<FrameNode | null>(null);
  const latest = useRef(props);
  latest.current = props;
  function post(message: object) {
    frame.current?.contentWindow?.postMessage({ source: "source-control-host", ...message }, "*");
  }
  function initialize() {
    const p = latest.current;
    post({
      type: "initialize",
      path: p.path,
      ...p.data,
      ...editorAppearance(p.theme),
      ...syntaxOptionsRef.current,
    });
  }
  useEffect(() => {
    const editorRef = props.editorRef;
    const handle = {
      saved: (revision: string) => post({ type: "saved", revision }),
      saveFailed: () => post({ type: "save-error" }),
    };
    props.editorRef.current = handle;
    function receive(event: FrameMessage) {
      if (event.source !== frame.current?.contentWindow) return;
      const parsed = editorEvent.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "ready") initialize();
      if (message.type === "changed") latest.current.onChange(message.content);
      if (message.type === "pin") latest.current.onKeepOpen();
      if (message.type === "mounted") setSyntaxError(null);
      if (message.type === "save") latest.current.onSave(message.content, message.revision);
      if (message.type === "error") setSyntaxError(message.message);
    }
    window.addEventListener("message", receive);
    initialize();
    return () => {
      window.removeEventListener("message", receive);
      if (editorRef.current === handle) editorRef.current = null;
    };
  }, [props.editorRef, props.path]);
  useEffect(() => {
    post({ type: "appearance", ...editorAppearance(props.theme), ...syntaxOptions });
  }, [props.theme, syntaxOptions]);
  useEffect(() => {
    if (!latest.current.dirty) post({ type: "disk-update", ...latest.current.data });
  }, [props.data.revision, props.path]);
  return createElement(
    View,
    { style: { flex: 1, minHeight: 0 } },
    syntaxError
      ? createElement(
          Text,
          {
            accessibilityRole: "alert",
            style: { color: props.theme.colors.statusDanger, padding: 10 },
          },
          syntaxError,
        )
      : null,
    createElement("iframe", {
      "data-mixer-editor": "",
      key: props.path,
      sandbox: "allow-scripts",
      ref: (node: FrameNode | null) => {
        frame.current = node;
      },
      title: `${props.path} diff editor`,
      srcDoc: editorHtml,
      onLoad: initialize,
      style: {
        display: "block",
        width: "100%",
        height: "100%",
        border: 0,
        flex: 1,
        background: props.theme.colors.surface0,
      },
    }),
  );
}

export function confirmAction(
  title: string,
  message: string,
  acceptLabel = "Confirm",
): Promise<boolean> {
  return confirmDialog({
    title,
    message,
    confirmLabel: acceptLabel,
    destructive: acceptLabel === "Discard" || acceptLabel === "Move to Trash",
  });
}

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}
