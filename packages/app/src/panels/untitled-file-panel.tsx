import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { FilePlus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { z } from "zod";
import { getDesktopHost } from "@/desktop/host";
import { useToast } from "@/contexts/toast-context";
import { editorStatus, type EditorLanguageState } from "@/file-panels/source/editor/status";
import { useAppSettings } from "@/hooks/use-settings";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { usePaneContext } from "./pane-context";
import { definePanel } from "./panel-registry";
import { usePublishPanelInstanceAttributes } from "./panel-instance-attributes";
import {
  editorEventSchema,
  type EditorConfiguration,
  type MonacoTheme,
} from "@/file-panels/source/editor/monaco/messages";
import type { Theme } from "@/styles/theme";

const draftSchema = z.object({
  content: z.string(),
  savedPath: z.string().optional(),
  savedContent: z.string().optional(),
  languageMode: z.string().nullable().optional(),
});
const ThemedFilePlus = withUnistyles(FilePlus);
const frameStyle = { flex: 1, width: "100%", minHeight: 0, border: 0 };

function UntitledFileEditor({ theme }: { theme: MonacoTheme }) {
  const pane = usePaneContext();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const root = useWorkspaceFields(
    pane.serverId,
    pane.workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const { settings } = useAppSettings();
  const parsed = draftSchema.safeParse(pane.state);
  const draft = parsed.success ? parsed.data : { content: "" };
  const frame = useRef<HTMLIFrameElement>(null);
  const revision = useRef(0);
  const focusedOnReady = useRef(false);
  const [booted, setBooted] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = useRef({ pane, draft, theme, settings });
  const statusRegistration = useRef<ReturnType<typeof editorStatus.register> | null>(null);
  const languageState = useRef<EditorLanguageState | null>(null);
  current.current = { pane, draft, theme, settings };
  const appearanceKey = JSON.stringify({
    theme,
    preferences: settings.editor,
    vim: settings.vimKeybindings,
  });
  usePublishPanelInstanceAttributes({ modified: draft.content !== (draft.savedContent ?? "") });

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saveText = getDesktopHost()?.dialog?.saveText;
      if (!saveText) throw new Error("Update the desktop app to save with the native file dialog.");
      const content = current.current.draft.content;
      const path = await saveText({
        content,
        defaultPath:
          current.current.draft.savedPath ??
          (root ? `${root.replace(/[\\/]+$/, "")}/Untitled.txt` : "Untitled.txt"),
      });
      if (!path) return;
      const next = { ...current.current.draft, savedPath: path, savedContent: content };
      current.current.draft = next;
      current.current.pane.setCurrentTabState(next);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [root, saving, toast]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const registration = editorStatus.register(
      editorStatus.key(pane.serverId, pane.workspaceId, pane.tabId),
      {
        filename: draft.savedPath ?? "Untitled.txt",
        selectLanguage: (mode) => {
          const next = { ...current.current.draft, languageMode: mode };
          current.current.draft = next;
          current.current.pane.setCurrentTabState(next);
        },
        focus: () =>
          frame.current?.contentWindow?.postMessage({ type: "focus" }, window.location.origin),
        quickPickBounds: () => {
          const bounds = frame.current?.getBoundingClientRect();
          return bounds
            ? { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }
            : null;
        },
      },
    );
    statusRegistration.current = registration;
    if (languageState.current) registration.publish(languageState.current);
    return () => {
      registration.dispose();
      if (statusRegistration.current === registration) statusRegistration.current = null;
    };
  }, [pane.serverId, pane.workspaceId, pane.tabId, draft.savedPath]);

  useEffect(() => {
    function receive(event: MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      const message = editorEventSchema.safeParse(event.data);
      if (!message.success) return;
      if (message.data.type === "booted") setBooted(true);
      if (message.data.type === "ready" && !focusedOnReady.current) {
        focusedOnReady.current = true;
        frame.current?.contentWindow?.postMessage({ type: "focus" }, window.location.origin);
      }
      if (message.data.type === "change") {
        revision.current = message.data.revision;
        const next = { ...current.current.draft, content: message.data.content };
        current.current.draft = next;
        current.current.pane.setCurrentTabState(next);
      }
      if (message.data.type === "save") {
        void saveRef.current();
      }
      if (message.data.type === "language-state") {
        const value = { id: message.data.id, modes: message.data.modes };
        languageState.current = value;
        statusRegistration.current?.publish(value);
      }
      if (message.data.type === "error") toastRef.current.error(message.data.message);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (!booted) return;
    const configuration: EditorConfiguration = {
      filename: current.current.draft.savedPath ?? "Untitled.txt",
      languageMode:
        current.current.draft.languageMode ??
        (current.current.draft.savedPath ? null : "plaintext"),
      content: current.current.draft.content,
      revision: revision.current,
      bufferVersion: 0,
      lineSeparator: "\n",
      theme: current.current.theme,
      vimEnabled: current.current.settings.vimKeybindings,
      preferences: {
        ...current.current.settings.editor,
        gitBlame: false,
        gitCodeLens: false,
        gitHover: false,
      },
      projectLanguageServices: false,
      historyOwner: "editor",
      viewState: null,
      gitAnnotations: false,
    };
    frame.current?.contentWindow?.postMessage(
      { type: "configure", configuration },
      window.location.origin,
    );
  }, [booted, appearanceKey, draft.savedPath, draft.languageMode]);
  return (
    <View style={styles.container}>
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- Trusted bundled Monaco runtime. */}
      <iframe ref={frame} src="/monaco/index.html" title="New file editor" style={frameStyle} />
    </View>
  );
}
const ThemedUntitledFileEditor = withUnistyles(UntitledFileEditor);
const editorTheme = (theme: Theme) => ({
  theme: {
    colorScheme: theme.colorScheme,
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    cursor: theme.colors.terminal.cursor,
    foregroundMuted: theme.colors.foregroundMuted,
    border: theme.colors.border,
    selection: theme.colors.terminal.selectionBackground,
    monoFont: theme.fontFamily.mono,
    codeFontSize: theme.fontSize.code,
  },
});
function UntitledFilePanel() {
  return <ThemedUntitledFileEditor uniProps={editorTheme} />;
}
export const untitledFilePanelRegistration = definePanel("untitled_file", {
  component: UntitledFilePanel,
  presentation: {
    label: () => "Untitled",
    subtitle: () => "File",
    tooltip: () => "New file",
    icon: ThemedFilePlus,
  },
});
const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
});
