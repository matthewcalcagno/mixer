import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
} from "react";
import {
  useFileText,
  type PluginFilePanelProps,
  type PluginFilePanelParams,
} from "@mixer/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatFileSize } from "@/utils/format-file-size";
import type { Theme } from "@/styles/theme";
import { FilePanelLoading } from "../loading";
import type { FileConflictAlertState } from "./conflict-alert";
import {
  getFileConflictCallout,
  type FileEditorModel,
  type FileEditorSnapshot,
} from "./editor/model";
import { useFileDocument } from "./editor/workspace";
import { FileEditorView } from "./editor/view";
import { selectSourcePresentation } from "./readonly/presentation";
import { FileSourceView } from "./readonly/view";
import { TextFileToolbar, type TextFileView } from "./toolbar";
// Source editors and native source rendering consume appearance as props. Subscribe at the
// rendering leaf so theme updates reconfigure it without replacing the editor/model.
const sourceAppearance = (theme: Theme) => ({
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
    syntax: theme.colors.syntax,
  },
});
const ThemedFileEditorView = withUnistyles(FileEditorView, sourceAppearance);
const ThemedFileSourceView = withUnistyles(FileSourceView, sourceAppearance);
/** The daemon refuses to write larger files. */
const MAX_EDITABLE_BYTES = 1024 * 1024;
/** A rendered view of the file's text: the panel's Preview, shown instead of its source. */
export interface TextFilePreviewProps {
  text: string;
  params: PluginFilePanelProps["params"];
  workspaceId: string;
  host: PluginFilePanelProps["host"];
}
type TextFilePanelProps = PluginFilePanelProps & {
  /** The panel's Preview; with one, the toolbar switches between Preview and Source. */
  preview?: ComponentType<TextFilePreviewProps>;
};
/**
 * What the Markdown, HTML and Source panels share: a toolbar over the file's Source view and, when
 * the panel passes one, its Preview. Both views show the one read of the file and, while editing, the one editor buffer, so switching
 * between them neither re-reads nor loses edits. Edits files up to 1 MiB on web; shows larger files
 * and every file on native read-only, and refuses files above the display budget before reading.
 */
export function TextFilePanel(props: TextFilePanelProps) {
  const size = props.file.size;
  const presentation = selectSourcePresentation({ size, platform: "web" });
  if (presentation === "unsupported") return <TooLargeTextFile size={size} />;
  if (size <= MAX_EDITABLE_BYTES) return <EditableTextFile {...props} />;
  return <ReadonlyTextFile {...props} presentation={presentation} />;
}
/**
 * The view a panel with a preview shows. It opens on Preview, and on Source for a line target;
 * each later line target switches to Source again.
 */
function useTextFileView(
  params: PluginFilePanelParams,
  revision: number,
): [TextFileView, (view: TextFileView) => void] {
  const lineTarget = params.lineStart ? revision : null;
  const [view, setView] = useState<TextFileView>(lineTarget === null ? "preview" : "source");
  const [shownLineTarget, setShownLineTarget] = useState(lineTarget);
  if (lineTarget !== null && lineTarget !== shownLineTarget) {
    setShownLineTarget(lineTarget);
    setView("source");
  }
  return [view, setView];
}
function TooLargeTextFile({ size }: { size: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="file-source-too-large">
      <Text style={styles.mutedText}>{t("panels.file.tooLargeToDisplay")}</Text>
      <Text style={styles.mutedText}>{formatFileSize(size)}</Text>
    </View>
  );
}
function ReadonlyTextFile({
  file,
  params,
  revision,
  workspaceId,
  host,
  preview: Preview,
  presentation,
}: TextFilePanelProps & {
  presentation: "highlighted" | "plain";
}) {
  const text = useFileText(file);
  const { t } = useTranslation();
  const [view, setView] = useTextFileView(params, revision);
  const sourceLocation = useMemo(
    () => ({ path: params.path, lineStart: params.lineStart, lineEnd: params.lineEnd }),
    [params.lineEnd, params.lineStart, params.path],
  );
  if (text.status === "loading") return <FilePanelLoading />;
  if (text.status === "error") {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{text.error.message || t("panels.file.failedToLoad")}</Text>
      </View>
    );
  }
  const showPreview = Preview !== undefined && view === "preview";
  return (
    <View style={styles.container}>
      <TextFileToolbar
        view={Preview ? view : undefined}
        onViewChange={Preview ? setView : undefined}
      />
      {showPreview ? (
        <Preview text={text.text} params={params} workspaceId={workspaceId} host={host} />
      ) : (
        <ThemedFileSourceView
          content={text.text}
          filename={params.path}
          location={sourceLocation}
          navigationRevision={revision}
          presentation={presentation}
        />
      )}
    </View>
  );
}
function EditableTextFile({
  file,
  tab,
  params,
  revision,
  workspaceId,
  host,
  preview: Preview,
}: TextFilePanelProps) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const document = useFileDocument();
  const model = document.model;
  const [view, setView] = useTextFileView(params, revision);
  const [vimMode, setVimMode] = useState<string | null>(settings.vimKeybindings ? "NORMAL" : null);
  const [sourceMounted, setSourceMounted] = useState(Preview === undefined || view === "source");
  if (view === "source" && !sourceMounted) setSourceMounted(true);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    tab.setModified(snapshot.modified);
  }, [snapshot.modified, tab]);
  const handleReload = useCallback(() => {
    if (!snapshot.modified) {
      void model.reload();
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("panels.file.editor.reloadTitle"),
        message: t("panels.file.editor.reloadMessage"),
        confirmLabel: t("panels.file.editor.reload"),
        destructive: true,
      });
      if (confirmed) void model.reload();
    })();
  }, [model, snapshot.modified, t]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const handleRetry = useCallback(() => void model.reload(), [model]);
  const editorLocation = useMemo(
    () => ({ path: params.path, lineStart: params.lineStart, lineEnd: params.lineEnd }),
    [params.lineEnd, params.lineStart, params.path],
  );
  if (snapshot.status === "loading") return <FilePanelLoading />;
  if (snapshot.status === "failed") {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{snapshot.error ?? t("panels.file.failedToLoad")}</Text>
        <Button variant="outline" size="sm" onPress={handleRetry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  const callout = getFileConflictCallout(snapshot);
  let conflict: FileConflictAlertState | null = null;
  if (callout?.kind === "deleted") conflict = { kind: "deleted" };
  else if (callout) {
    conflict = {
      kind: "changed",
      canOverwrite: callout.canOverwrite,
      onReload: handleReload,
      onOverwrite: handleOverwrite,
    };
  }
  const showPreview = Preview !== undefined && view === "preview";
  return (
    <View style={styles.container}>
      <EditorRecoveryNotice model={model} snapshot={snapshot} onReload={handleReload} />
      <TextFileToolbar
        view={Preview ? view : undefined}
        onViewChange={Preview ? setView : undefined}
        editorStatus={snapshot.status}
        vimMode={showPreview ? null : vimMode}
        conflict={conflict}
      />
      {showPreview ? (
        <Preview text={snapshot.content} params={params} workspaceId={workspaceId} host={host} />
      ) : null}
      {sourceMounted ? (
        <View style={showPreview ? styles.hiddenEditor : styles.editor}>
          <SourceEditor
            document={document}
            model={model}
            filename={file.path}
            location={editorLocation}
            navigationRevision={revision}
            vimEnabled={settings.vimKeybindings}
            onVimModeChange={setVimMode}
          />
        </View>
      ) : null}
    </View>
  );
}
function EditorRecoveryNotice({
  model,
  snapshot,
  onReload,
}: {
  model: FileEditorModel;
  snapshot: FileEditorSnapshot;
  onReload(): void;
}) {
  const save = useCallback(() => void model.save(), [model]);
  const retry = useCallback(() => void model.retryBackup(), [model]);
  return (
    <>
      {snapshot.recovered ? (
        <View style={styles.recovery} testID="file-recovered-draft">
          <Text style={styles.mutedText}>
            {snapshot.conflict
              ? "Recovered a local draft. The file also changed on disk. Review your recovered text before overwriting or reloading."
              : "Recovered unsaved changes from local storage. Save them to keep this draft, or reload to discard it."}
          </Text>
          {!snapshot.conflict ? (
            <Button variant="outline" size="sm" onPress={save}>
              Save recovered draft
            </Button>
          ) : null}
          {!snapshot.conflict ? (
            <Button variant="ghost" size="sm" onPress={onReload}>
              Discard recovered draft
            </Button>
          ) : null}
        </View>
      ) : null}
      {snapshot.recoveryError ? (
        <View style={styles.recovery} testID="file-draft-backup-error">
          <Text style={styles.errorText}>Local draft recovery: {snapshot.recoveryError}</Text>
          <Button variant="outline" size="sm" onPress={retry}>
            Retry backup
          </Button>
        </View>
      ) : null}
    </>
  );
}
/** The editor over the panel's buffer. Each mount shows Loading until the editor shows the text. */
function SourceEditor(props: Omit<ComponentProps<typeof ThemedFileEditorView>, "onReady">) {
  const [ready, setReady] = useState(false);
  const handleReady = useCallback(() => setReady(true), []);
  return (
    <View style={styles.editor}>
      <ThemedFileEditorView {...props} onReady={handleReady} />
      {ready ? null : <FilePanelLoading />}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  editor: { flex: 1, minHeight: 0 },
  hiddenEditor: { display: "none" },
  recovery: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
