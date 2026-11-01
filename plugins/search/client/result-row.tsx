import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { FileIcon, Icon } from "@mixer/plugin/client/ui";
import type { PluginTheme } from "@mixer/plugin";
import type { SearchRow } from "./model.js";
import type { SearchStyles } from "./styles.js";

interface ResultRowProps {
  row: SearchRow;
  styles: SearchStyles;
  theme: PluginTheme;
  collapsed: boolean;
  onToggle(path: string): void;
  onOpen(path: string, line: number): void;
}
export function ResultRow({ row, styles, theme, collapsed, onToggle, onOpen }: ResultRowProps) {
  const onPress = useCallback(() => {
    if (row.kind === "file") onToggle(row.path);
    else onOpen(row.path, row.match.line);
  }, [row, onToggle, onOpen]);
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      row.kind === "file" ? styles.file : styles.hit,
      pressed && styles.pressed,
    ],
    [row.kind, styles],
  );
  const state = useMemo(
    () => (row.kind === "file" ? { expanded: !collapsed } : {}),
    [row.kind, collapsed],
  );
  if (row.kind === "file") {
    const slash = row.path.lastIndexOf("/");
    const name = row.path.slice(slash + 1);
    const directory = slash < 0 ? "" : row.path.slice(0, slash);
    return (
      <Pressable
        onPress={onPress}
        style={rowStyle}
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${row.path}`}
        accessibilityState={state}
      >
        <View style={styles.chevron}>
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </View>
        <FileIcon fileName={row.path} size={16} />
        <Text numberOfLines={1} style={styles.filename}>
          {name}
        </Text>
        <Text numberOfLines={1} style={styles.directory}>
          {directory}
        </Text>
        <Text style={styles.badge}>{row.count}</Text>
      </Pressable>
    );
  }
  const { match } = row;
  return (
    <Pressable
      onPress={onPress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`Open ${row.path}:${match.line}:${match.column}. ${match.preview}`}
      testID={`search-hit-${row.path}-${match.line}-${match.column}`}
    >
      <Text style={styles.line}>{match.line}</Text>
      <Text numberOfLines={1} style={styles.preview}>
        {match.preview.slice(0, match.start)}
        <Text style={styles.highlight}>{match.preview.slice(match.start, match.end)}</Text>
        {match.preview.slice(match.end)}
      </Text>
    </Pressable>
  );
}
