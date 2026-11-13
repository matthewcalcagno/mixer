import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { FloatingAgentChat as PluginChat } from "@mixer/plugin/client/ui";
import { FloatingSurface } from "@/components/ui/floating";
import { PaneHeader } from "@/components/ui/pane-content-toolbar";
import { PaneHeaderAction } from "./pane-header-action";
import { Button } from "./button";
import { AgentChat } from "./agent-chat";

export const AGENT_CHAT_LAUNCHER_CLEARANCE = 56;
export function FloatingAgentChat({
  serverId,
  conversation,
  draft,
  open,
  launcherVisible = true,
  onOpenChange,
  contextFile,
  title,
  onOpenFile,
  onOpenAgent,
  children,
  testID,
  notice,
  accessibilityLabel = "Ask AI",
}: ComponentProps<typeof PluginChat>) {
  const body = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    setFocused(open);
    if (!open) return;
    const pointer = (event: PointerEvent) =>
      setFocused(event.target instanceof Node && !!body.current?.contains(event.target));
    const blur = () => {
      if (!body.current?.contains(document.activeElement)) setFocused(false);
    };
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("blur", blur);
    };
  }, [open]);
  const focus = useCallback(() => setFocused(true), []);
  const toggle = useCallback(() => onOpenChange(!open), [onOpenChange, open]);
  const minimize = useCallback(() => onOpenChange(false), [onOpenChange]);
  const expand = useCallback(() => {
    if (conversation) onOpenAgent(conversation.agentId);
  }, [conversation, onOpenAgent]);
  const frame = useMemo(() => [styles.window, !open && styles.hidden], [open]);
  return (
    <>
      <FloatingSurface style={frame} testID={testID}>
        <div ref={body} style={bodyStyle} onFocusCapture={focus}>
          <PaneHeader title={title}>
            {conversation && (
              <PaneHeaderAction
                icon="ExternalLink"
                label="Open full conversation"
                onPress={expand}
              />
            )}
            <PaneHeaderAction icon="Minus" label="Minimize AI" onPress={minimize} />
          </PaneHeader>
          {notice && <Text style={styles.notice}>{notice}</Text>}
          {conversation && (
            <AgentChat
              serverId={serverId}
              workspaceId={conversation.workspaceId}
              agentId={conversation.agentId}
              active={open}
              focused={focused}
              contextFile={contextFile}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          )}
          {!conversation && draft && (
            <AgentChat
              serverId={serverId}
              workspaceId={draft.workspaceId}
              draft={draft}
              active={open}
              focused={focused}
              contextFile={contextFile}
              onOpenFile={onOpenFile}
              onOpenAgent={onOpenAgent}
            />
          )}
          {!conversation && !draft && children}
        </div>
      </FloatingSurface>
      {launcherVisible && (
        <View style={styles.launcher}>
          <Button
            size="sm"
            variant="outline"
            icon="Sparkles"
            accessibilityLabel={accessibilityLabel}
            onPress={toggle}
          >
            Ask AI
          </Button>
        </View>
      )}
    </>
  );
}
const bodyStyle = { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;
const styles = StyleSheet.create((theme) => ({
  window: {
    position: "absolute",
    right: 12,
    bottom: AGENT_CHAT_LAUNCHER_CLEARANCE,
    width: 440,
    height: 560,
    maxWidth: "95%",
    maxHeight: "75%",
    zIndex: 20,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.xl,
    overflow: "hidden",
    ...theme.shadow.md,
  },
  hidden: { display: "none" },
  launcher: { position: "absolute", right: 12, bottom: 12, zIndex: 21 },
  notice: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
