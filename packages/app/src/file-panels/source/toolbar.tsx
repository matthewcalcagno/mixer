import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { FileConflictAlert, type FileConflictAlertState } from "./conflict-alert";
import type { FileEditorStatus } from "./editor/model";

export type TextFileView = "preview" | "source";

/**
 * Only reserve a toolbar for preview controls, Vim mode, or a save failure.
 * Ordinary source files start directly below their tab rail.
 */
export function TextFileToolbar({
  view,
  onViewChange,
  editorStatus,
  vimMode,
  conflict,
}: {
  view?: TextFileView;
  onViewChange?(view: TextFileView): void;
  editorStatus?: FileEditorStatus;
  vimMode?: string | null;
  conflict?: FileConflictAlertState | null;
}) {
  const { t } = useTranslation();
  const showStatus = editorStatus === "error" || Boolean(vimMode);
  const showToolbar = showStatus || Boolean(view && onViewChange);
  if (!showToolbar && !conflict) return null;
  const views = [
    {
      value: "preview" as const,
      label: t("panels.file.editor.preview"),
      testID: "file-mode-preview",
    },
    { value: "source" as const, label: t("panels.file.editor.source"), testID: "file-mode-source" },
  ];
  return (
    <View style={styles.chrome}>
      {showToolbar ? (
        <PaneContentToolbar testID="file-panel-bar">
          <View style={styles.row}>
            <View
              style={styles.status}
              accessibilityLabel={
                editorStatus
                  ? t("panels.file.editor.editorStatus", { status: editorStatus })
                  : undefined
              }
            >
              {editorStatus === "error" ? (
                <Text style={styles.error}>{t("panels.file.editor.saveFailed")}</Text>
              ) : null}
              {vimMode ? (
                <Text
                  style={styles.vim}
                  accessibilityLabel={t("panels.file.editor.vimMode", { mode: vimMode })}
                >
                  {vimMode}
                </Text>
              ) : null}
            </View>
            {view && onViewChange ? (
              <SegmentedControl
                size="xs"
                value={view}
                onValueChange={onViewChange}
                testID="file-preview-mode"
                options={views}
              />
            ) : null}
          </View>
        </PaneContentToolbar>
      ) : null}
      {conflict ? <FileConflictAlert state={conflict} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
  },
  row: {
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  status: {
    flex: 1,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  vim: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
