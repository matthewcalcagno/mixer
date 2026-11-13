import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import type { FileTreeRowProps } from "@mixer/plugin/client/ui";
import { MaterialFileIcon, MaterialFolderIcon } from "@/components/material-file-icon";
import {
  TreeChevron,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_SIZE,
  WORKSPACE_TREE_ICON_LABEL_GAP,
} from "@/components/tree-primitives";
import { fileExplorerRowMetrics, fileExplorerRowPaddingLeft } from "@/file-explorer/geometry";

export function FileTreeRow({ path, depth, expanded, selected, onPress }: FileTreeRowProps) {
  const [hovered, setHovered] = useState(false);
  const enter = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  const directory = expanded !== undefined;
  const name = path.split("/").at(-1) ?? path;
  const row = useMemo(
    () => [
      workspaceTreeRowStyles.row,
      styles.row,
      { paddingLeft: fileExplorerRowPaddingLeft(depth) },
      (selected || hovered) && workspaceTreeRowStyles.active,
    ],
    [depth, selected, hovered],
  );
  const label = useMemo(
    () => [
      styles.name,
      workspaceTreeRowStyles.name,
      (selected || hovered) && workspaceTreeRowStyles.nameHovered,
    ],
    [selected, hovered],
  );
  const state = useMemo(() => ({ selected, expanded }), [selected, expanded]);
  return (
    <View onPointerEnter={enter} onPointerLeave={leave}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={`${directory ? "Folder" : "Open"} ${path}`}
        accessibilityState={state}
        onPress={onPress}
        style={row}
      >
        <View style={styles.info}>
          <View style={styles.icon}>{directory && <TreeChevron expanded={expanded} />}</View>
          <View style={styles.icon}>
            {directory ? (
              <MaterialFolderIcon
                folderName={name}
                expanded={expanded}
                size={WORKSPACE_TREE_ICON_SIZE}
              />
            ) : (
              <MaterialFileIcon fileName={name} size={WORKSPACE_TREE_ICON_SIZE} />
            )}
          </View>
          <Text numberOfLines={1} style={label}>
            {name}
          </Text>
        </View>
      </PressHighlight>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: { minHeight: fileExplorerRowMetrics(theme.fontSize.chrome).minHeight },
  info: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    minWidth: 0,
  },
  icon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  name: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.chrome,
    fontFamily: theme.fontFamily.ui,
    fontWeight: theme.fontWeight.medium,
    lineHeight: fileExplorerRowMetrics(theme.fontSize.chrome).lineHeight,
    userSelect: "none",
  },
}));
