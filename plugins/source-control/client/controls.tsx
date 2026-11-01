import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  Easing,
  Platform,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import { Icon } from "@mixer/plugin/client/ui";
import type { PluginTheme } from "@mixer/plugin";
import { getFileIconSvg } from "./vendor/file-icon-svg.js";
import { useReducedMotion } from "./use-reduced-motion.js";
import type { ResourceKeyAction, SelectionGesture } from "../shared/selection.js";

interface RowKeyEvent {
  target: unknown;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function HoverBoundary({
  children,
  onHoverChange,
  onKeyDown,
}: {
  children: ReactNode;
  onHoverChange(hovered: boolean): void;
  onKeyDown?(event: RowKeyEvent): void;
}) {
  if (Platform.OS === "web") {
    return createElement(
      "div",
      {
        style: { display: "contents" },
        onMouseEnter: () => onHoverChange(true),
        onMouseLeave: () => onHoverChange(false),
        onKeyDown,
      },
      children,
    );
  }
  return children;
}

export const commitOptions = [
  { value: "commit", label: "Commit" },
  { value: "amend", label: "Commit (Amend)" },
  { value: "commit-push", label: "Commit & Push" },
  { value: "commit-sync", label: "Commit & Sync" },
] as const;
export type CommitOption = (typeof commitOptions)[number]["value"];

export interface NativeSelectorOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export function NativeActionSelector({
  label,
  options,
  disabled,
  color,
  onSelect,
}: {
  label: string;
  options: NativeSelectorOption[];
  disabled: boolean;
  color: string;
  onSelect(value: string): void;
}) {
  function choose() {
    const available = options.filter((option) => !option.disabled);
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...available.map((option) => option.label), "Cancel"],
          cancelButtonIndex: available.length,
        },
        (index) => {
          const option = available[index];
          if (option) onSelect(option.value);
        },
      );
      return;
    }
    function page(offset: number) {
      const entries = available
        .slice(offset, offset + 2)
        .map((option) => ({ text: option.label, onPress: () => onSelect(option.value) }));
      if (available.length > offset + 2)
        entries.push({ text: "More…", onPress: () => page(offset + 2) });
      Alert.alert(label, undefined, entries, { cancelable: true });
    }
    page(0);
  }
  return (
    <View
      style={{
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon name="Ellipsis" size={16} color={color} />
      {Platform.OS === "web" ? (
        createElement(
          "select",
          {
            "aria-label": label,
            "data-testid": "source-control-actions",
            disabled,
            value: "",
            onChange: (event: { target: { value: string } }) => {
              const option = options.find(
                (entry) => entry.value === event.target.value && !entry.disabled,
              );
              if (option) onSelect(option.value);
            },
            style: {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: disabled ? "default" : "pointer",
            },
          },
          createElement("option", { value: "", disabled: true, hidden: true }, label),
          ...options.map((option) =>
            createElement(
              "option",
              { key: option.value, value: option.value, disabled: option.disabled },
              option.label,
            ),
          ),
        )
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={disabled}
          onPress={choose}
          style={{ position: "absolute", inset: 0 }}
        />
      )}
    </View>
  );
}

export function CommitDropdown({
  disabled,
  canCommit,
  canAmend,
  remoteDisabled,
  color,
  onSelect,
}: {
  disabled: boolean;
  canCommit: boolean;
  canAmend: boolean;
  remoteDisabled: boolean;
  color: string;
  onSelect(option: CommitOption): void;
}) {
  const options = commitOptions.map((option) => ({
    ...option,
    disabled:
      (option.value === "amend" ? !canAmend : !canCommit) ||
      (remoteDisabled && (option.value === "commit-push" || option.value === "commit-sync")),
  }));
  return (
    <View
      style={{
        width: 30,
        alignSelf: "stretch",
        borderLeftWidth: 1,
        borderLeftColor: "#ffffff33",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="ChevronDown" size={16} color={color} />
      {Platform.OS === "web" ? (
        createElement(
          "select",
          {
            "aria-label": "Commit options",
            disabled,
            value: "",
            onChange: (event: { target: { value: string } }) => {
              const option = commitOptions.find((item) => item.value === event.target.value);
              if (option) onSelect(option.value);
            },
            style: {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: disabled ? "default" : "pointer",
            },
          },
          createElement("option", { value: "", disabled: true, hidden: true }, "Commit options"),
          ...options.map((option) =>
            createElement(
              "option",
              { key: option.value, value: option.value, disabled: option.disabled },
              option.label,
            ),
          ),
        )
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Commit options"
          disabled={disabled}
          onPress={() => {
            const available = options.filter((option) => !option.disabled);
            if (Platform.OS === "android" && available.length > 3) {
              Alert.alert("Commit options", "Choose an action", [
                { text: "Commit", onPress: () => onSelect("commit") },
                { text: "Commit (Amend)", onPress: () => onSelect("amend") },
                {
                  text: "Commit &…",
                  onPress: () =>
                    Alert.alert(
                      "Commit &…",
                      "Choose an action",
                      available
                        .filter(
                          (option) =>
                            option.value === "commit-push" || option.value === "commit-sync",
                        )
                        .map((option) => ({
                          text: option.label,
                          onPress: () => onSelect(option.value),
                        })),
                    ),
                },
              ]);
            } else
              Alert.alert(
                "Commit options",
                "Choose an action",
                available.map((option) => ({
                  text: option.label,
                  onPress: () => onSelect(option.value),
                })),
              );
          }}
          style={{ position: "absolute", inset: 0 }}
        />
      )}
    </View>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  theme,
  onFocusChange,
}: {
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  theme: PluginTheme;
  onFocusChange?(focused: boolean): void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tooltipMounted, setTooltipMounted] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  const visible = (hover || focus) && !disabled;
  useEffect(() => {
    if (visible) setTooltipMounted(true);
    const activeDuration = visible ? 140 : 90;
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: reducedMotion ? 0 : activeDuration,
      delay: reducedMotion || !visible ? 0 : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setTooltipMounted(false);
    });
    return () => animation.stop();
  }, [visible, reducedMotion, opacity]);
  return (
    <View style={{ zIndex: tooltipMounted || hover || focus ? 20 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onPress}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        onFocus={() => {
          setFocus(true);
          onFocusChange?.(true);
        }}
        onBlur={() => {
          setFocus(false);
          onFocusChange?.(false);
        }}
        style={({ pressed }) => ({
          width: Platform.OS === "web" ? 22 : 36,
          height: Platform.OS === "web" ? 22 : 36,
          borderRadius: 4,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.35 : 1,
          backgroundColor: hover || focus || pressed ? theme.colors.surface2 : "transparent",
        })}
      >
        <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>
      {tooltipMounted && (
        <Animated.View
          testID="source-control-tooltip"
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 0,
            top: 27,
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 4,
            backgroundColor: theme.colors.surface2,
            minWidth: 110,
            opacity,
            transform: [
              { translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [3, 0] }) },
            ],
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foreground,
              fontSize: 11,
              ...(Platform.OS === "web" ? { whiteSpace: "nowrap" } : {}),
            }}
          >
            {label}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

function fileAppearance(
  status: string,
  selected: boolean,
  active: boolean,
  theme: PluginTheme,
  label?: string,
) {
  const colors: Record<string, string> = {
    D: theme.colors.statusDanger,
    A: theme.colors.statusSuccess,
    "?": theme.colors.statusSuccess,
  };
  let backgroundColor = "transparent";
  if (active) backgroundColor = theme.colors.surface1;
  if (selected) backgroundColor = `${theme.colors.inputFocus}24`;
  let badge = status === "?" ? "U" : status;
  if (label) badge = "!";
  const color = label ? theme.colors.statusWarning : (colors[status] ?? theme.colors.statusWarning);
  return { color, backgroundColor, badge };
}

export function FileRow({
  path,
  status,
  statusLabel,
  indent = 0,
  hideDirectory = false,
  staged,
  selected,
  disabled,
  theme,
  onStage,
  onDiscard,
  onOpenFile,
  focused,
  active,
  stageLabel,
  discardLabel,
  onSelect,
  onKeyAction,
  onRowFocus,
}: {
  path: string;
  status: string;
  staged: boolean;
  selected: boolean;
  disabled: boolean;
  theme: PluginTheme;
  onStage(): void;
  onDiscard?: () => void;
  onOpenFile?: () => void;
  statusLabel?: string;
  indent?: number;
  hideDirectory?: boolean;
  focused: boolean;
  active: boolean;
  stageLabel: string;
  discardLabel: string;
  onSelect(gesture: SelectionGesture): void;
  onKeyAction(action: ResourceKeyAction): void;
  onRowFocus(): void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const row = useRef<View>(null);
  useEffect(() => {
    if (focused && Platform.OS === "web") row.current?.focus();
  }, [focused]);
  function select(event: GestureResponderEvent) {
    const native = event.nativeEvent;
    const range = "shiftKey" in native && native.shiftKey === true;
    const toggle =
      ("metaKey" in native && native.metaKey === true) ||
      ("ctrlKey" in native && native.ctrlKey === true);
    if (range) onSelect(toggle ? "add-range" : "range");
    else onSelect(toggle ? "toggle" : "replace");
  }
  function keyDown(event: RowKeyEvent) {
    if (event.target !== row.current) return;
    const modifier = event.ctrlKey || event.metaKey;
    let action: ResourceKeyAction;
    if (modifier && event.key.toLowerCase() === "a") action = { kind: "all" };
    else if (event.key === "Escape") action = { kind: "clear" };
    else if (event.key === " ") action = { kind: "toggle" };
    else if (event.key === "Enter") action = { kind: "open" };
    else {
      const directions = {
        ArrowDown: "next",
        ArrowUp: "previous",
        Home: "first",
        End: "last",
      } as const;
      const direction = Object.entries(directions).find(([key]) => key === event.key)?.[1];
      if (!direction) return;
      action = { kind: "navigate", direction, extend: event.shiftKey, additive: modifier };
    }
    event.preventDefault();
    event.stopPropagation();
    onKeyAction(action);
  }
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const directory = slash < 0 ? "" : path.slice(0, slash);
  const { color, backgroundColor, badge } = fileAppearance(
    status,
    selected,
    hover || focus || active,
    theme,
    statusLabel,
  );
  const showActions = hover || focus || Platform.OS !== "web";
  return (
    <HoverBoundary onHoverChange={setHover} onKeyDown={keyDown}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 22,
          paddingLeft: 18 + indent,
          paddingRight: 4,
          borderRadius: 4,
          backgroundColor,
          zIndex: hover || focus ? 5 : 0,
        }}
      >
        <Pressable
          ref={row}
          accessibilityRole="button"
          accessibilityLabel={
            status === "?"
              ? `Open file ${path}`
              : `Open ${staged ? "staged" : "working tree"} diff for ${path}`
          }
          accessibilityState={{ selected }}
          aria-selected={selected}
          onPress={select}
          onFocus={() => {
            setFocus(true);
            onRowFocus();
          }}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            minHeight: 22,
          }}
        >
          <Icon icon={{ svg: getFileIconSvg(path) }} size={16} />
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              flexShrink: 1,
              textDecorationLine: status === "D" ? "line-through" : "none",
            }}
          >
            {name}
          </Text>
          {!!directory && !hideDirectory && (
            <Text
              numberOfLines={1}
              ellipsizeMode="middle"
              style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}
            >
              {directory}
            </Text>
          )}
        </Pressable>
        <FileRowActions
          visible={showActions}
          staged={staged}
          disabled={disabled}
          theme={theme}
          stageLabel={stageLabel}
          discardLabel={discardLabel}
          onStage={onStage}
          onDiscard={onDiscard}
          onOpenFile={onOpenFile}
          onFocusChange={setFocus}
        />
        <Text
          accessibilityLabel={statusLabel ?? `Git status ${status}`}
          style={{ color, fontSize: 12, width: 18, textAlign: "center", fontWeight: "600" }}
        >
          {badge}
        </Text>
      </View>
    </HoverBoundary>
  );
}

function FileRowActions({
  visible,
  staged,
  disabled,
  theme,
  stageLabel,
  discardLabel,
  onStage,
  onDiscard,
  onOpenFile,
  onFocusChange,
}: {
  visible: boolean;
  staged: boolean;
  disabled: boolean;
  theme: PluginTheme;
  stageLabel: string;
  discardLabel: string;
  onStage(): void;
  onDiscard?: () => void;
  onOpenFile?: () => void;
  onFocusChange(focused: boolean): void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        width: visible ? undefined : 0,
        overflow: visible ? "visible" : "hidden",
      }}
    >
      {onOpenFile && (
        <IconButton
          icon="FileSymlink"
          label="Open file"
          onPress={onOpenFile}
          theme={theme}
          onFocusChange={onFocusChange}
        />
      )}
      {onDiscard && (
        <IconButton
          icon="Undo2"
          label={discardLabel}
          onPress={onDiscard}
          disabled={disabled}
          theme={theme}
          onFocusChange={onFocusChange}
        />
      )}
      <IconButton
        icon={staged ? "Minus" : "Plus"}
        label={stageLabel}
        onPress={onStage}
        disabled={disabled}
        theme={theme}
        onFocusChange={onFocusChange}
      />
    </View>
  );
}
