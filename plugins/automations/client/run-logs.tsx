import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { PluginTheme } from "@mixer/plugin";
import { Button } from "@mixer/plugin/client/ui";
import { classifyRunLogLine, inspectRunLogs } from "../shared/run-inspection.js";

function useLogStyles(theme: PluginTheme) {
  return useMemo(() => {
    const size = theme.typography?.small ?? 12;
    return {
      frame: { flex: 1, minHeight: 0 },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: size },
      scroll: { flex: 1, minHeight: 0 },
      body: { paddingVertical: 12 },
      row: {
        flexDirection: "row" as const,
        paddingHorizontal: 12,
        borderLeftWidth: 2,
        borderLeftColor: "transparent",
      },
      number: {
        width: size * 5,
        paddingRight: 16,
        textAlign: "right" as const,
        color: theme.colors.foregroundMuted,
        fontFamily: theme.typography?.monoFontFamily,
        fontSize: size,
        lineHeight: size * 1.8,
        userSelect: "none" as const,
      },
      text: {
        flex: 1,
        minWidth: 0,
        fontFamily: theme.typography?.monoFontFamily,
        fontSize: size,
        lineHeight: size * 1.8,
        color: theme.colors.foreground,
      },
      command: {
        backgroundColor: theme.colors.surface1,
        borderLeftColor: theme.colors.foregroundMuted,
        marginTop: 8,
        paddingVertical: 4,
      },
      tool: { backgroundColor: theme.colors.surface1, marginTop: 4, paddingVertical: 2 },
      heading: { marginTop: 12, paddingVertical: 4, borderLeftColor: theme.colors.border },
      headingText: { color: theme.colors.foregroundMuted },
      error: { borderLeftColor: theme.colors.statusDanger },
      errorText: { color: theme.colors.statusDanger },
      warning: { borderLeftColor: theme.colors.statusWarning },
      warningText: { color: theme.colors.statusWarning },
    };
  }, [theme]);
}

const LogLine = memo(function LogLine({
  line,
  index,
  styles,
}: {
  line: string;
  index: number;
  styles: ReturnType<typeof useLogStyles>;
}) {
  const kind = classifyRunLogLine(line);
  const rowStyle = useMemo(() => [styles.row, kind !== "output" && styles[kind]], [styles, kind]);
  const textStyle = useMemo(
    () => [
      styles.text,
      kind === "heading" && styles.headingText,
      kind === "error" && styles.errorText,
      kind === "warning" && styles.warningText,
    ],
    [styles, kind],
  );
  return (
    <View style={rowStyle}>
      <Text aria-hidden style={styles.number}>
        {index + 1}
      </Text>
      <Text selectable style={textStyle}>
        {line || " "}
      </Text>
    </View>
  );
});

export function RunLogs({
  output,
  active,
  theme,
}: {
  output: string;
  active: boolean;
  theme: PluginTheme;
}) {
  const scroll = useRef<ScrollView>(null);
  const following = useRef(active);
  const [follow, setFollow] = useState(active);
  const content = useMemo(() => inspectRunLogs(output).content, [output]);
  const lines = useMemo(() => content.replace(/\n$/, "").split("\n"), [content]);
  const styles = useLogStyles(theme);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const bottom = contentSize.height - layoutMeasurement.height - contentOffset.y <= 32;
    following.current = bottom;
    setFollow(bottom);
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (following.current) scroll.current?.scrollToEnd({ animated: false });
  }, []);
  const jumpToLatest = useCallback(() => {
    following.current = true;
    setFollow(true);
    scroll.current?.scrollToEnd({ animated: false });
  }, []);
  const pause = useCallback(() => {
    following.current = false;
    setFollow(false);
  }, []);
  return (
    <View style={styles.frame} testID="automations-run-logs">
      <View style={styles.toolbar}>
        <Text style={styles.meta}>
          {active ? "Live output" : "Run output"}
          {` · ${lines.length.toLocaleString()} lines`}
          {active && (follow ? " · Following" : " · Scroll paused")}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          icon={active && follow ? "Pause" : "ArrowDown"}
          onPress={active && follow ? pause : jumpToLatest}
        >
          {active && follow ? "Pause scrolling" : "Jump to latest"}
        </Button>
      </View>
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.body}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
      >
        {lines.map((line, index) => (
          // eslint-disable-next-line react/no-array-index-key -- Append-only log lines retain their line number as new output arrives.
          <LogLine key={index} index={index} line={line} styles={styles} />
        ))}
      </ScrollView>
    </View>
  );
}
