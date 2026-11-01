import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";

export function SidebarSections({
  actions,
  children,
  keepActionsVisible = false,
}: {
  actions: ReactNode;
  children: ReactNode;
  keepActionsVisible?: boolean;
}) {
  const savedRatio = useSidebarViewStore((state) => state.actionsSectionRatio ?? null);
  const saveRatio = useSidebarViewStore((state) => state.setActionsSectionRatio);
  const { items } = useSidebarNavItems("header");
  const hasActions = keepActionsVisible || items.some((item) => item.visible);
  const [height, setHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const ratio = previewRatio ?? savedRatio;
  let actionsHeight: number | undefined;
  if (height > 0) {
    if (ratio !== null) actionsHeight = height * ratio;
    else if (contentHeight > 0) actionsHeight = Math.min(contentHeight, height / 2);
  }
  const actionsStyle = useMemo(
    () => [
      styles.actions,
      ratio === null && styles.automaticActions,
      actionsHeight !== undefined && { height: actionsHeight },
    ],
    [actionsHeight, ratio],
  );
  const sizes = useMemo(() => {
    const fraction = actionsHeight !== undefined && height > 0 ? actionsHeight / height : 0.5;
    return [fraction, 1 - fraction];
  }, [actionsHeight, height]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height),
    [],
  );
  const onContentSize = useCallback((_width: number, next: number) => setContentHeight(next), []);
  const preview = useCallback((_group: string, next: number[]) => {
    if (next[0] !== undefined) setPreviewRatio(next[0]);
  }, []);
  const commit = useCallback(
    (_group: string, next: number[]) => {
      if (next[0] !== undefined) saveRatio(next[0]);
      setPreviewRatio(null);
    },
    [saveRatio],
  );
  return (
    <View style={styles.root} onLayout={onLayout} testID="sidebar-sections">
      {hasActions ? (
        <>
          <ScrollView
            style={actionsStyle}
            onContentSizeChange={onContentSize}
            testID="sidebar-actions-scroll"
          >
            {actions}
          </ScrollView>
          <View style={styles.divider}>
            <ResizeHandle
              testID="sidebar-actions-divider"
              direction="vertical"
              groupId="sidebar-sections"
              index={0}
              sizes={sizes}
              containerSize={height}
              onPreviewResizeSplit={preview}
              onResizeSplit={commit}
            />
          </View>
        </>
      ) : null}
      <View style={styles.workspaces} testID="sidebar-workspaces-section">
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  actions: { flexGrow: 0, flexShrink: 0, maxHeight: "90%" },
  automaticActions: { maxHeight: "50%" },
  workspaces: { flex: 1, minHeight: 0 },
  divider: { height: 1, flexShrink: 0, backgroundColor: theme.colors.border },
}));
