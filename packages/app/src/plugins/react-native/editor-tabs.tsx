import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { EditorTabsProps } from "@mixer/plugin/client/ui";
import { ScrollView } from "./scroll-view";
import { FileIcon } from "./file-icon";
import { Bot } from "lucide-react-native";
import { PaneHeaderAction } from "./pane-header-action";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  TAB_CHIP_GAP,
  TAB_CHIP_HEIGHT,
  TAB_ROW_PADDING_HORIZONTAL,
  createEditorTabStyles,
} from "@/components/ui/editor-tab-geometry";

export function EditorTabs({
  files,
  fixedTabs = [],
  selected,
  onSelect,
  onClose,
}: EditorTabsProps) {
  return (
    <View style={styles.rail}>
      {fixedTabs.map((tab) => (
        <EditorTab
          key={tab.id}
          path={tab.id}
          fixedLabel={tab.label}
          selected={selected === tab.id}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
      <View style={styles.scroll}>
        <ScrollView horizontal contentContainerStyle={styles.content}>
          {files.map((file) => (
            <EditorTab
              key={file.path}
              path={file.path}
              dirty={file.dirty}
              kind={file.kind}
              title={file.label}
              selected={selected === file.path}
              onSelect={onSelect}
              onClose={onClose}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}
function EditorTab({
  path,
  dirty,
  kind,
  title,
  selected,
  onSelect,
  onClose,
  fixedLabel,
}: Pick<EditorTabsProps, "onSelect" | "onClose"> & {
  path: string;
  dirty?: boolean;
  kind?: "file" | "agent";
  title?: string;
  selected: boolean;
  fixedLabel?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const select = useCallback(() => onSelect(path), [onSelect, path]);
  const close = useCallback(() => onClose(path), [onClose, path]);
  const frame = useMemo(
    () => [
      styles.tab,
      styles.tabDense,
      styles.widthCap,
      selected ? styles.active : hovered && styles.hovered,
    ],
    [selected, hovered],
  );
  const label = useMemo(() => [styles.tabLabel, selected && styles.tabLabelActive], [selected]);
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={frame} onPointerEnter={enter} onPointerLeave={leave}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PressHighlight
            accessibilityRole="button"
            accessibilityLabel={
              fixedLabel ?? (kind === "agent" ? `Agent ${path.slice(6)}` : `Edit ${path}`)
            }
            accessibilityState={state}
            onPress={select}
            style={styles.handle}
          >
            {!fixedLabel &&
              (kind === "agent" ? (
                <Bot size={14} color={styles.tabLabel.color} />
              ) : (
                <FileIcon fileName={path} size={14} />
              ))}
            <Text numberOfLines={1} style={label}>
              {fixedLabel ?? title ?? path.split("/").at(-1)}
            </Text>
          </PressHighlight>
        </TooltipTrigger>
        <TooltipContent>
          <Text style={styles.tooltip}>{fixedLabel ?? path}</Text>
        </TooltipContent>
      </Tooltip>
      {!fixedLabel && (
        <View style={styles.trailing}>
          {dirty ? (
            <View accessibilityLabel="Unsaved changes" style={styles.dot} />
          ) : (
            (selected || hovered) && (
              <PaneHeaderAction icon="X" label={`Close ${path}`} onPress={close} />
            )
          )}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  ...createEditorTabStyles(theme),
  rail: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
    height: TAB_CHIP_HEIGHT + theme.spacing[1] * 2,
    maxHeight: TAB_CHIP_HEIGHT + theme.spacing[1] * 2,
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
    paddingVertical: theme.spacing[1],
    gap: TAB_CHIP_GAP,
  },
  scroll: { flex: 1, minWidth: 0 },
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.chrome },
  widthCap: { maxWidth: 360 },
  active: { backgroundColor: theme.colors.surface2 },
  hovered: { backgroundColor: theme.colors.surface1 },
  handle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    flexShrink: 1,
  },
  trailing: { width: 14, height: TAB_CHIP_HEIGHT, alignItems: "center", justifyContent: "center" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.foregroundMuted },
}));
