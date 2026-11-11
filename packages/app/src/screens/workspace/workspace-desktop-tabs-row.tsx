import type { FileTabRevealActions } from "./workspace-tab-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  isFixedExplorerTarget,
  isExplorerNavigationTarget,
} from "@/workspace-tabs/explorer-navigation";
import React, {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Pressable, Text, View, type LayoutChangeEvent, type ScrollView } from "react-native";
import { useFilePanelOpenWithMenu } from "@/file-panels";
import {
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  Pencil,
  Pin,
  RotateCw,
  Columns2,
  Rows2,
  Ellipsis,
  Maximize,
  Minimize,
  Plus,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { SortableInlineList } from "@/components/sortable-inline-list";
import type {
  DraggableListDragHandleProps,
  DraggableRenderItemInfo,
} from "@/components/draggable-list.types";
import { isNative } from "@/constants/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { Shortcut } from "@/components/ui/shortcut";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import { retainWorkspaceTabMeasuredWidth } from "@/screens/workspace/workspace-tab-layout";
import type { WorkspaceTabSizing } from "@/screens/workspace/workspace-tab-layout";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  buildWorkspaceDesktopTabActions,
  type WorkspaceDesktopTabActions,
  type WorkspaceTabMenuEntry,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { PaneHost } from "@/panels/panel-manifest";
import type { WorkspaceTabLaunchPurpose } from "@/workspace-tabs/launcher";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import {
  resolveWorkspaceTabChipBackdrop,
  type WorkspaceTabRailSurface,
} from "@/screens/workspace/workspace-tab-chip-backdrop";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { RenderProfile } from "@/utils/render-profiler";
import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { formatCompactTimeAgoAsProse } from "@/utils/time";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { WorkspaceNewTabMenuContent } from "@/screens/workspace/workspace-new-tab-menu";
import {
  paneContentToolbarTrailingPadding,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import {
  HorizontalScrollBoundaryShades,
  useHorizontalScrollBoundary,
} from "@/components/ui/horizontal-scroll-boundary";
import { useSessionStore } from "@/stores/session-store";
import { ExplorerActivityTab } from "./explorer-sidebar/activity-tab";
import { usesFileTabLabel } from "@/workspace-tabs/file-label";
import { WorkspaceTabInlineName, useIsTabRenaming } from "./use-workspace-tab-rename";
import { keepPreviewTabOpen } from "@/workspace-tabs/preview";
import { useNativeTabContextMenu } from "./use-native-tab-context-menu";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
const DROPDOWN_WIDTH = 220;
const EDITOR_TABS_DATASET = { "editor-pane-tabs": "true" };
const NEW_TAB_ACTION_RESERVED_WIDTH = 36;
const PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING = 2;
const PANE_SPLIT_ACTIONS_OUTER_MARGIN =
  paneContentToolbarTrailingPadding(false, "glyph") - PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING;
const PANE_SPLIT_ACTIONS_RESERVED_WIDTH =
  smallIconButtonChromeFrameSize(false) +
  PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING * 2 +
  PANE_SPLIT_ACTIONS_OUTER_MARGIN;
const PANE_MAXIMIZE_ACTION_RESERVED_WIDTH = smallIconButtonChromeFrameSize(false) + 1;
// Chip geometry. `layoutMetrics` measures tabs from these same numbers, so a chip that changes
// shape without changing them mis-measures and drops the row into the overflow-scroll fallback at
// the wrong width. Keep them together.
// Actions remain outside the scrolling tab strip so their positions do not depend on tab widths.
const TAB_CHIP_HORIZONTAL_PADDING = 8;
const TAB_CHIP_GAP = 2;
const TAB_CHIP_HEIGHT = 24;
const TAB_ROW_PADDING_HORIZONTAL = 4;
const TAB_ICON_WIDTH = 14;
const TAB_ICON_SIZES: Record<WorkspaceTabRailSurface, number> = {
  surface: ICON_SIZE.sm,
  sidebar: ICON_SIZE.md,
};
const TAB_CONTENT_GAP = 4;
const TAB_DROP_INDICATOR_WIDTH = 4;
const TAB_MODIFIED_DOT_SIZE = 8;
const TAB_MIN_WIDTH = 64;
const TAB_MAX_WIDTH = 160;
const FILE_TAB_MAX_WIDTH = 360;
const FILE_TAB_TRAILING_WIDTH = 14;
const PIN_MARKER_SIZE = 12;
const TAB_CLOSE_BUTTON_RESERVED_WIDTH = 0;
const TAB_LABEL_LAYOUT_ALLOWANCE = 4;
const AGENT_TOOLTIP_TITLE_MAX_LENGTH = 80;
interface TabRailDensityInput {
  isCompact: boolean;
  rail: WorkspaceTabRailSurface;
}
function isDenseDesktopTabRail({ isCompact, rail }: TabRailDensityInput) {
  return !isCompact && rail === "surface";
}
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedX = withUnistyles(X);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedCopyX = withUnistyles(CopyX);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPin = withUnistyles(Pin);
const ThemedPlus = withUnistyles(Plus);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedRows2 = withUnistyles(Rows2);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedMaximize = withUnistyles(Maximize);
const ThemedMinimize = withUnistyles(Minimize);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
function updateMeasuredWidth(
  setWidth: React.Dispatch<React.SetStateAction<number>>,
  event: LayoutChangeEvent,
) {
  const nextWidth = Math.round(event.nativeEvent.layout.width);
  setWidth((current) => retainWorkspaceTabMeasuredWidth(current, nextWidth));
}
function normalizeAgentTooltipTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}
function formatAgentTooltipTitle(singleLineTitle: string): string {
  if (singleLineTitle.length <= AGENT_TOOLTIP_TITLE_MAX_LENGTH) return singleLineTitle;
  return `${singleLineTitle.slice(0, AGENT_TOOLTIP_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}
function AgentTabTooltipBody({
  serverId,
  agentId,
  title,
}: {
  serverId: string;
  agentId: string;
  title: string;
}) {
  const lastActivityAt = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
    return state.agentLastActivity.get(agentId) ?? agent?.lastActivityAt ?? null;
  });
  const compactActivity = useCompactTimeAgo(lastActivityAt);
  const activity = formatCompactTimeAgoAsProse(compactActivity);
  return (
    <View style={styles.tooltipAgentContent}>
      <Text style={styles.agentTooltipTitle} numberOfLines={1} ellipsizeMode="tail">
        {title}
      </Text>
      <View style={styles.tooltipAgentMetadata}>
        <Text style={styles.tooltipAgentId}>{agentId.slice(0, 7)}</Text>
        {activity ? (
          <>
            <Text style={styles.tooltipAgentSeparator}>·</Text>
            <Text style={styles.tooltipAgentActivity}>{activity}</Text>
          </>
        ) : null}
      </View>
    </View>
  );
}
function TabLabelMeasurement({
  tabKey,
  label,
  onMeasure,
}: {
  tabKey: string;
  label: string;
  onMeasure: (tabKey: string, label: string, event: LayoutChangeEvent) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(tabKey, label, event),
    [label, onMeasure, tabKey],
  );
  return (
    <Text
      style={[styles.tabLabel, styles.tabLabelMeasurement]}
      numberOfLines={1}
      onLayout={handleLayout}
    >
      {label}
    </Text>
  );
}
type PanePanelKinds = readonly WorkspaceTabDescriptor["kind"][];
interface WorkspaceNewTabButtonProps {
  panePanelKinds: PanePanelKinds;
  host: PaneHost;
  launchPurpose: WorkspaceTabLaunchPurpose;
  serverId: string;
  paneId?: string;
  shortcutKeys: ShortcutKey[][] | null;
}
function WorkspaceNewTabButton({
  panePanelKinds,
  host,
  launchPurpose,
  serverId,
  paneId,
  shortcutKeys,
}: WorkspaceNewTabButtonProps) {
  const { t } = useTranslation();
  const tooltipText = t("workspace.tabs.actions.newTab");
  const menu = (
    <DropdownMenu>
      <ToolbarButton
        kind="menu"
        label={tooltipText}
        shortcut={shortcutKeys}
        testID="workspace-new-tab-button"
      >
        <ThemedPlus size={14} uniProps={extraMutedColorMapping} />
      </ToolbarButton>
      <WorkspaceNewTabMenuContent
        serverId={serverId}
        purpose={launchPurpose}
        host={host}
        panePanelKinds={panePanelKinds}
        paneId={paneId}
      />
    </DropdownMenu>
  );
  return menu;
}
function WorkspacePaneToolbarActions({
  panePanelKinds,
  host,
  launchPurpose,
  showSplitActions,
  showMaximizeAction,
  paneMaximized,
  serverId,
  paneId,
  newTabShortcutKeys,
  onSplitRight,
  onSplitDown,
  onTogglePaneMaximized,
}: {
  panePanelKinds: PanePanelKinds;
  host: PaneHost;
  launchPurpose: WorkspaceTabLaunchPurpose;
  showSplitActions: boolean;
  showMaximizeAction: boolean;
  paneMaximized: boolean;
  serverId: string;
  paneId?: string;
  newTabShortcutKeys: ShortcutKey[][] | null;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onTogglePaneMaximized?: () => void;
}) {
  const { t } = useTranslation();
  const splitRightKeys = useShortcutKeys("workspace-pane-split-right");
  const splitDownKeys = useShortcutKeys("workspace-pane-split-down");
  const splitActionsVisible = showSplitActions && Boolean(onSplitRight && onSplitDown);
  const splitRightLeading = useMemo(
    () => <ThemedColumns2 size={14} uniProps={extraMutedColorMapping} />,
    [],
  );
  const splitDownLeading = useMemo(
    () => <ThemedRows2 size={14} uniProps={extraMutedColorMapping} />,
    [],
  );
  const splitRightTrailing = useMemo(
    () => (splitRightKeys ? <Shortcut chord={splitRightKeys} /> : null),
    [splitRightKeys],
  );
  const splitDownTrailing = useMemo(
    () => (splitDownKeys ? <Shortcut chord={splitDownKeys} /> : null),
    [splitDownKeys],
  );
  const maximizeActionVisible = showMaximizeAction && Boolean(onTogglePaneMaximized);
  return (
    <ToolbarControls style={styles.paneSplitActions}>
      <WorkspaceNewTabButton
        panePanelKinds={panePanelKinds}
        host={host}
        launchPurpose={launchPurpose}
        serverId={serverId}
        paneId={paneId}
        shortcutKeys={newTabShortcutKeys}
      />
      {maximizeActionVisible && onTogglePaneMaximized ? (
        <ToolbarButton
          label={t(
            paneMaximized
              ? "workspace.tabs.actions.restorePane"
              : "workspace.tabs.actions.maximizePane",
          )}
          selected={paneMaximized}
          testID={paneMaximized ? "workspace-restore-pane" : "workspace-maximize-pane"}
          onPress={onTogglePaneMaximized}
        >
          {paneMaximized ? (
            <ThemedMinimize size={14} uniProps={extraMutedColorMapping} />
          ) : (
            <ThemedMaximize size={14} uniProps={extraMutedColorMapping} />
          )}
        </ToolbarButton>
      ) : null}
      {splitActionsVisible && onSplitRight && onSplitDown ? (
        <DropdownMenu>
          <ToolbarButton
            kind="menu"
            label={t("workspace.git.actions.moreActions")}
            testID="workspace-split-pane-menu"
          >
            <ThemedEllipsis size={14} uniProps={extraMutedColorMapping} />
          </ToolbarButton>
          <DropdownMenuContent
            side="bottom"
            align="end"
            offset={4}
            width={220}
            testID="workspace-split-pane-menu-content"
          >
            <DropdownMenuItem
              leading={splitRightLeading}
              trailing={splitRightTrailing}
              testID="workspace-split-pane-right"
              onSelect={onSplitRight}
            >
              {t("workspace.tabs.actions.splitRight")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={splitDownLeading}
              trailing={splitDownTrailing}
              testID="workspace-split-pane-down"
              onSelect={onSplitDown}
            >
              {t("workspace.tabs.actions.splitDown")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </ToolbarControls>
  );
}
function WorkspaceExitFocusModeButton({
  visible,
  onPress,
  onLayout,
}: {
  visible: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const focusModeKeys = useShortcutKeys("toggle-focus");
  if (!visible) {
    return null;
  }
  return (
    <View style={styles.exitFocusModeSlot} onLayout={onLayout}>
      <ToolbarButton
        label={t("workspace.tabs.actions.exitFocusMode")}
        shortcut={focusModeKeys}
        testID="workspace-exit-focus-mode"
        onPress={onPress}
      >
        <ThemedX size={14} uniProps={mutedColorMapping} />
      </ToolbarButton>
    </View>
  );
}
function TabContextMenuItem({
  entry,
}: {
  entry: Extract<
    WorkspaceTabMenuEntry,
    {
      kind: "item";
    }
  >;
}) {
  const leading = useMemo(() => {
    switch (entry.icon) {
      case "copy":
        return <ThemedCopy size={16} uniProps={mutedColorMapping} />;
      case "rotate-cw":
        return <ThemedRotateCw size={16} uniProps={mutedColorMapping} />;
      case "arrow-left-to-line":
        return <ThemedArrowLeftToLine size={16} uniProps={mutedColorMapping} />;
      case "arrow-right-to-line":
        return <ThemedArrowRightToLine size={16} uniProps={mutedColorMapping} />;
      case "copy-x":
        return <ThemedCopyX size={16} uniProps={mutedColorMapping} />;
      case "pencil":
        return <ThemedPencil size={16} uniProps={mutedColorMapping} />;
      case "x":
        return <ThemedX size={16} uniProps={mutedColorMapping} />;
      default:
        return undefined;
    }
  }, [entry.icon]);
  const trailing = useMemo(
    () => (entry.hint ? <Text style={styles.menuItemHint}>{entry.hint}</Text> : undefined),
    [entry.hint],
  );
  return (
    <ContextMenuItem
      testID={entry.testID}
      disabled={entry.disabled}
      destructive={entry.destructive}
      onSelect={entry.onSelect}
      tooltip={entry.tooltip}
      leading={leading}
      trailing={trailing}
    >
      {entry.label}
    </ContextMenuItem>
  );
}
function tabKeyExtractor(tab: WorkspaceDesktopTabRowItem) {
  return `${tab.tab.key}:${tab.tab.kind}`;
}
export interface WorkspaceDesktopTabRowItem {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
}
interface ResolvedWorkspaceDesktopTabRowItem extends WorkspaceDesktopTabRowItem {
  presentation: WorkspaceTabPresentation;
}
interface WorkspaceTabLabel {
  key: string;
  label: string;
  modified: boolean;
}
interface WorkspaceTabLabelMeasurement {
  label: string;
  width: number;
}
interface WorkspaceTabTrackSnapshot {
  signature: string;
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
  labels: WorkspaceTabLabel[];
  labelWidths: number[];
}
function workspaceTabLabelSignature(labels: WorkspaceTabLabel[]): string {
  return JSON.stringify(labels);
}
function completeWorkspaceTabLabelWidths(
  labels: WorkspaceTabLabel[],
  measurements: Map<string, WorkspaceTabLabelMeasurement>,
): number[] | null {
  const widths: number[] = [];
  for (const { key, label, modified } of labels) {
    const measurement = measurements.get(key);
    if (!measurement || measurement.label !== label || measurement.width <= 0) {
      return null;
    }
    // The modified dot sits in the content row, so a modified tab needs that much more width
    // before its label starts truncating.
    const modifiedAllowance = modified ? TAB_CONTENT_GAP + TAB_MODIFIED_DOT_SIZE : 0;
    widths.push(measurement.width + TAB_LABEL_LAYOUT_ALLOWANCE + modifiedAllowance);
  }
  return widths;
}
function sameWidths(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((width, index) => width === right[index]);
}
export interface WorkspaceDesktopTabsRowProps {
  host?: PaneHost;
  launchPurpose?: WorkspaceTabLaunchPurpose;
  paneId?: string;
  isFocused?: boolean;
  ownsKeyboardShortcuts?: boolean;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  fileRevealActions?: FileTabRevealActions;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  onCreateNewTab: (input: { paneId?: string }) => void;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
  showPaneSplitActions?: boolean;
  workspaceHasMultiplePanes?: boolean;
  showPaneMaximizeAction?: boolean;
  paneMaximized?: boolean;
  onTogglePaneMaximized?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  focusModeEnabled: boolean;
  onExitFocusMode: () => void;
}
interface ResolvedWorkspaceDesktopTabsRowProps extends Omit<WorkspaceDesktopTabsRowProps, "tabs"> {
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
}
interface WorkspaceDesktopTabPresentationSlotProps {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  onResolve: (tabKey: string, presentation: WorkspaceTabPresentation) => void;
}
const EMPTY_RESOLVED_TAB_ROWS: ResolvedWorkspaceDesktopTabRowItem[] = [];
function WorkspaceDesktopTabPresentationSlot({
  tab,
  serverId,
  workspaceId,
  onResolve,
}: WorkspaceDesktopTabPresentationSlotProps) {
  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <WorkspaceDesktopTabPresentationCommit
          tabKey={tab.key}
          presentation={presentation}
          onResolve={onResolve}
        />
      )}
    </WorkspaceTabPresentationResolver>
  );
}
function WorkspaceDesktopTabPresentationCommit({
  tabKey,
  presentation,
  onResolve,
}: {
  tabKey: string;
  presentation: WorkspaceTabPresentation;
  onResolve: (tabKey: string, presentation: WorkspaceTabPresentation) => void;
}) {
  useLayoutEffect(() => {
    onResolve(tabKey, presentation);
  }, [onResolve, presentation, tabKey]);
  return null;
}
function getFallbackTabLabel(
  tab: WorkspaceTabDescriptor,
  labels: {
    newTab: string;
    newAgent: string;
    setup: string;
    terminal: string;
    agent: string;
    changes: string;
    files: string;
    pullRequest: string;
  },
): string {
  if (tab.target.kind === "new_tab") {
    return labels.newTab;
  }
  if (tab.target.kind === "draft") {
    return labels.newAgent;
  }
  if (tab.target.kind === "setup") {
    return labels.setup;
  }
  if (tab.target.kind === "terminal") {
    return labels.terminal;
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").findLast(Boolean) ?? tab.target.path;
  }
  if (tab.target.kind === "working_diff" || tab.target.kind === "changes_tree") {
    return labels.changes;
  }
  if (tab.target.kind === "files") {
    return labels.files;
  }
  if (tab.target.kind === "pull_request") {
    return labels.pullRequest;
  }
  return labels.agent;
}
function useTabPointerActions(onClose: () => void, onKeepOpen: () => void) {
  const ref = useRef<View>(null);
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;
    function handleAuxClick(event: MouseEvent) {
      if (event.button === 1) {
        event.preventDefault();
        onClose();
      }
    }
    function handleDoubleClick(event: MouseEvent) {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-inline-tab-rename='true']")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onKeepOpen();
    }
    node.addEventListener("auxclick", handleAuxClick);
    node.addEventListener("dblclick", handleDoubleClick);
    return () => {
      node.removeEventListener("auxclick", handleAuxClick);
      node.removeEventListener("dblclick", handleDoubleClick);
    };
  }, [onClose, onKeepOpen]);
  return ref;
}
function TabHandleContent({
  tab,
  presentation,
  isHighlighted,
  showLabel,
  backdrop,
  tabLabelSkeletonStyle,
  tabLabelStyle,
  modifiedTestId,
  iconSize,
  isFileLabel,
  pinned,
  hideIcon,
}: {
  tab: WorkspaceTabDescriptor;
  presentation: WorkspaceTabPresentation;
  isHighlighted: boolean;
  showLabel: boolean;
  backdrop: SurfaceBackdrop;
  tabLabelSkeletonStyle: React.ComponentProps<typeof View>["style"];
  tabLabelStyle: React.ComponentProps<typeof Text>["style"];
  modifiedTestId: string;
  iconSize: number;
  isFileLabel: boolean;
  pinned: boolean;
  hideIcon: boolean;
}) {
  const { t } = useTranslation();
  const tabHandleDataSet = useMemo(
    () => ({ statusBucket: presentation.statusBucket ?? "none" }),
    [presentation.statusBucket],
  );
  const iconStyle = useMemo(
    () => [styles.tabIcon, { width: iconSize, height: iconSize }],
    [iconSize],
  );
  return (
    <View style={styles.tabHandle} dataSet={tabHandleDataSet}>
      {!hideIcon ? (
        <View style={iconStyle}>
          <WorkspaceTabIcon
            presentation={presentation}
            active={isHighlighted}
            backdrop={backdrop}
            size={iconSize}
          />
        </View>
      ) : null}
      {showLabel && presentation.titleState === "loading" ? (
        <View style={tabLabelSkeletonStyle} />
      ) : null}
      {showLabel && presentation.titleState !== "loading" ? (
        <Text
          style={tabLabelStyle}
          selectable={false}
          numberOfLines={1}
          ellipsizeMode={isFileLabel ? "clip" : "tail"}
        >
          <WorkspaceTabInlineName tab={tab}>{presentation.label}</WorkspaceTabInlineName>
        </Text>
      ) : null}
      {/* The dot is a laid-out sibling of the label, not an overlay, so a truncated label ends
              before it instead of running underneath it. */}
      {presentation.modified ? (
        <View
          style={styles.tabModifiedDot}
          accessibilityLabel={t("workspace.tabs.modified")}
          testID={modifiedTestId}
        />
      ) : null}
      {pinned && showLabel ? (
        <View style={styles.tabPin} testID="workspace-tab-pin-indicator">
          <ThemedPin size={PIN_MARKER_SIZE} uniProps={mutedColorMapping} />
        </View>
      ) : null}
    </View>
  );
}
function TabChip({
  serverId,
  workspaceId,
  tab,
  isActive,
  isDragging,
  isFocused,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  rail,
  isCloseHovered,
  isClosingTab,
  presentation,
  tooltipLabel,
  accessibilityLabel,
  resolvedTab,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
}: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isDragging: boolean;
  isFocused: boolean;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  /** The surface the row paints, so chip fills and their knockouts match the host. */
  rail: WorkspaceTabRailSurface;
  isCloseHovered: boolean;
  isClosingTab: boolean;
  presentation: WorkspaceTabPresentation;
  tooltipLabel: string;
  accessibilityLabel: string;
  resolvedTab: WorkspaceDesktopTabActions;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: DraggableListDragHandleProps | undefined;
}) {
  const { closeButtonTestId, contextMenuTestId } = resolvedTab;
  const isRenaming = useIsTabRenaming(tab.key);
  const { t } = useTranslation();
  const togglePin = useCallback(() => {
    useWorkspaceLayoutStore
      .getState()
      .setTabPinned(`${serverId}:${workspaceId}`, tab.tabId, !tab.pinned);
  }, [serverId, workspaceId, tab.tabId, tab.pinned]);
  const menuEntries = useMemo<WorkspaceTabMenuEntry[]>(() => {
    if (rail !== "surface" || tab.target.kind === "new_tab" || isFixedExplorerTarget(tab.target))
      return resolvedTab.menuEntries;
    return [
      {
        kind: "item",
        key: "toggle-pin",
        label: t(tab.pinned ? "workspace.tabs.menu.unpin" : "workspace.tabs.menu.pin"),
        testID: `${contextMenuTestId}-pin`,
        onSelect: togglePin,
      },
      { kind: "separator", key: "pin-separator" },
      ...resolvedTab.menuEntries,
    ];
  }, [rail, tab.target, tab.pinned, resolvedTab.menuEntries, t, contextMenuTestId, togglePin]);
  const openWith = useFilePanelOpenWithMenu(
    { serverId, workspaceId, tabId: tab.tabId },
    contextMenuTestId,
  );
  const middleClickRef = useTabPointerActions(
    useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]),
    useCallback(
      () => keepPreviewTabOpen(`${serverId}:${workspaceId}`, tab.tabId),
      [serverId, workspaceId, tab.tabId],
    ),
  );
  useNativeTabContextMenu({
    ref: middleClickRef,
    entries: menuEntries,
    openWith: openWith.nativeMenu,
  });
  const isCompact = useIsCompactFormFactor();
  const isFileLabel = usesFileTabLabel(tab.target);
  useEffect(() => {
    if (!isActive || !isFileLabel) return;
    const node = middleClickRef.current;
    if (node instanceof HTMLElement)
      node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [isActive, isFileLabel, resolvedTabWidth, middleClickRef]);
  const [hovered, setHovered] = useState(false);
  // An active tab in a pane that does not have focus stays legible but quiet: it keeps the fill of
  // a hovered chip and the muted label, so only one chip in the window reads as the live one.
  const isActiveFocused = isActive && isFocused;
  const isHovered = hovered || isCloseHovered;
  const isHighlighted = isActiveFocused || isHovered;
  const isFilled = isActive || isHovered;
  const chipBackdrop: SurfaceBackdrop = resolveWorkspaceTabChipBackdrop({
    rail,
    isActiveFocused,
    isFilled,
  });
  const showCloseControl = showCloseButton && (isHovered || isNative || isCompact || isClosingTab);
  const closeButtonDragBlockers = {
    onPointerDown: (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
    },
    onMouseDown: (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
    },
  } as const;
  const tabChipStyle = useCallback(
    () => [
      styles.tab,
      isFileLabel && styles.fileTab(showCloseButton),
      isDenseDesktopTabRail({ isCompact, rail }) && styles.tabDense,
      rail === "sidebar" && styles.explorerTab,
      isFilled && styles.tabFill(chipBackdrop),
      isDragging && ({ cursor: "grabbing" } as object),
      {
        minWidth: resolvedTabWidth,
        width: resolvedTabWidth,
        maxWidth: resolvedTabWidth,
      },
    ],
    [
      chipBackdrop,
      isDragging,
      isFilled,
      resolvedTabWidth,
      rail,
      isCompact,
      isFileLabel,
      showCloseButton,
    ],
  );
  const handleTabPointerEnter = useCallback(() => {
    setHovered(true);
  }, []);
  const handleTabPointerLeave = useCallback(() => {
    setHovered(false);
  }, []);
  const handleNavigateTab = useCallback(() => {
    onNavigateTab(tab.tabId);
  }, [onNavigateTab, tab.tabId]);
  const handleCloseButtonPressIn = useCallback((event: { stopPropagation?: () => void }) => {
    event.stopPropagation?.();
  }, []);
  const handleCloseButtonHoverIn = useCallback(() => {
    setHoveredCloseTabKey(tab.key);
  }, [setHoveredCloseTabKey, tab.key]);
  const handleCloseButtonHoverOut = useCallback(() => {
    setHoveredCloseTabKey((current) => (current === tab.key ? null : current));
  }, [setHoveredCloseTabKey, tab.key]);
  const handleCloseButtonPress = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      void onCloseTab(tab.tabId);
    },
    [onCloseTab, tab.tabId],
  );
  const tabAccessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const testIdentity =
    tab.target.kind === "new_tab" ? tab.tabId : buildDeterministicWorkspaceTabId(tab.target);
  const tabLabelSkeletonStyle = styles.tabLabelSkeleton;
  const tabLabelStyle = useMemo(
    () => [
      styles.tabLabel,
      isFileLabel && styles.fileTabLabel,
      isHighlighted && styles.tabLabelActive,
      presentation.preview && styles.tabLabelPreview,
    ],
    [isHighlighted, isFileLabel, presentation.preview],
  );
  const contextMenu = useMemo(
    () => (
      <ContextMenuContent
        align="start"
        width={DROPDOWN_WIDTH}
        pages={openWith.pages}
        testID={contextMenuTestId}
      >
        {menuEntries.map((entry) => {
          if (entry.kind === "separator") return <ContextMenuSeparator key={entry.key} />;
          if (entry.kind === "file-panel-open-with")
            return <Fragment key={entry.key}>{openWith.trigger}</Fragment>;
          return <TabContextMenuItem key={entry.key} entry={entry} />;
        })}
      </ContextMenuContent>
    ),
    [contextMenuTestId, menuEntries, openWith.pages, openWith.trigger],
  );
  if (rail === "sidebar" && isExplorerNavigationTarget(tab.target)) {
    return (
      <View ref={middleClickRef}>
        <ExplorerActivityTab
          label={accessibilityLabel}
          selected={isActive}
          focused={isFocused}
          onPress={handleNavigateTab}
          testID={`workspace-tab-${testIdentity}`}
          menu={contextMenu}
        >
          <WorkspaceTabIcon
            presentation={presentation}
            active={isActiveFocused}
            size={ICON_SIZE.md}
            backdrop={chipBackdrop}
          />
        </ExplorerActivityTab>
      </View>
    );
  }
  return (
    <View
      ref={middleClickRef}
      style={styles.tabHoverFrame}
      onPointerEnter={handleTabPointerEnter}
      onPointerLeave={handleTabPointerLeave}
    >
      <ContextMenu key={tab.key}>
        <Tooltip delayDuration={400} enabledOnDesktop={!isRenaming} enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              {...(dragHandleProps?.attributes as object | undefined)}
              {...(dragHandleProps?.listeners as object | undefined)}
              testID={`workspace-tab-${testIdentity}`}
              triggerRef={dragHandleProps?.setActivatorNodeRef as unknown as undefined}
              style={tabChipStyle}
              onPress={handleNavigateTab}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityState={tabAccessibilityState}
              aria-selected={isActive}
            >
              <TabHandleContent
                tab={tab}
                isFileLabel={isFileLabel}
                pinned={tab.pinned === true}
                presentation={presentation}
                isHighlighted={isHighlighted}
                showLabel={showLabel || isRenaming}
                backdrop={chipBackdrop}
                tabLabelSkeletonStyle={tabLabelSkeletonStyle}
                tabLabelStyle={tabLabelStyle}
                modifiedTestId={`workspace-tab-modified-${testIdentity}`}
                iconSize={TAB_ICON_SIZES[rail]}
                hideIcon={tab.target.kind === "new_tab"}
              />
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            offset={8}
            maxWidth={720}
            testID={`workspace-tab-tooltip-${testIdentity}`}
          >
            {tab.target.kind === "agent" ? (
              <AgentTabTooltipBody
                serverId={serverId}
                agentId={tab.target.agentId}
                title={tooltipLabel}
              />
            ) : (
              <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
            )}
          </TooltipContent>
        </Tooltip>

        {showCloseButton ? (
          <View
            pointerEvents={showCloseControl ? "box-none" : "none"}
            style={[
              styles.tabTrailingOverlay(isFileLabel),
              showCloseControl ? styles.tabTrailingOverlayShown : styles.tabTrailingOverlayHidden,
            ]}
          >
            <TrailingActionScrim backdrop={chipBackdrop} />
            <Pressable
              {...(closeButtonDragBlockers as object | undefined)}
              testID={closeButtonTestId}
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.menu.close")}
              disabled={isClosingTab}
              onPressIn={handleCloseButtonPressIn}
              onHoverIn={handleCloseButtonHoverIn}
              onHoverOut={handleCloseButtonHoverOut}
              onPress={handleCloseButtonPress}
              style={styles.tabCloseButton}
            >
              {({ hovered: closeHovered, pressed }) => {
                const highlighted = closeHovered || pressed;
                if (isClosingTab) {
                  return (
                    <ThemedLoadingSpinner
                      size={12}
                      uniProps={highlighted ? foregroundColorMapping : mutedColorMapping}
                    />
                  );
                }
                return (
                  <ThemedX
                    size={12}
                    uniProps={highlighted ? foregroundColorMapping : mutedColorMapping}
                  />
                );
              }}
            </Pressable>
          </View>
        ) : null}

        {contextMenu}
      </ContextMenu>
    </View>
  );
}
export function WorkspaceDesktopTabsRow(props: WorkspaceDesktopTabsRowProps) {
  const [presentations, setPresentations] = useState(
    () => new Map<string, WorkspaceTabPresentation>(),
  );
  const handlePresentation = useCallback(
    (tabKey: string, presentation: WorkspaceTabPresentation) => {
      setPresentations((current) => {
        if (current.get(tabKey) === presentation) {
          return current;
        }
        const next = new Map(current);
        next.set(tabKey, presentation);
        return next;
      });
    },
    [],
  );
  const currentTabKeys = useMemo(
    () => new Set(props.tabs.map((item) => item.tab.key)),
    [props.tabs],
  );
  useEffect(() => {
    setPresentations((current) => {
      const removedKeys = [...current.keys()].filter((key) => !currentTabKeys.has(key));
      if (removedKeys.length === 0) {
        return current;
      }
      const next = new Map(current);
      for (const key of removedKeys) {
        next.delete(key);
      }
      return next;
    });
  }, [currentTabKeys]);
  const resolvedTabs = useMemo(
    () =>
      props.tabs.flatMap((item) => {
        const presentation = presentations.get(item.tab.key);
        return presentation ? [{ ...item, presentation }] : [];
      }),
    [presentations, props.tabs],
  );
  return (
    <>
      <ResolvedWorkspaceDesktopTabsRow {...props} tabs={resolvedTabs} />
      {props.tabs.map(({ tab }) => (
        <WorkspaceDesktopTabPresentationSlot
          key={`${tab.key}:${tab.kind}`}
          tab={tab}
          serverId={props.normalizedServerId}
          workspaceId={props.normalizedWorkspaceId}
          onResolve={handlePresentation}
        />
      ))}
    </>
  );
}
function ResolvedWorkspaceDesktopTabsRow({
  host = "main",
  launchPurpose = "primary",
  paneId,
  isFocused = false,
  ownsKeyboardShortcuts = isFocused,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  fileRevealActions,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateNewTab,
  onReorderTabs,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
  showPaneSplitActions = false,
  workspaceHasMultiplePanes,
  showPaneMaximizeAction = false,
  paneMaximized = false,
  onTogglePaneMaximized,
  onSplitRight,
  onSplitDown,
  focusModeEnabled,
  onExitFocusMode,
}: ResolvedWorkspaceDesktopTabsRowProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const iconOnly = host === "explorer";
  const newTabKeys = useShortcutKeys("workspace-tab-new");
  const [tabsContainerWidth, setTabsContainerWidth] = useState<number>(0);
  const tabsScrollRef = useRef<ScrollView>(null);
  const [exitFocusModeWidth, setExitFocusModeWidth] = useState<number>(0);
  const tabScrollBoundary = useHorizontalScrollBoundary();
  const [labelMeasurements, setLabelMeasurements] = useState(
    () => new Map<string, WorkspaceTabLabelMeasurement>(),
  );
  const [trackSnapshot, setTrackSnapshot] = useState<WorkspaceTabTrackSnapshot | null>(null);
  const handleTabsContainerLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsContainerWidth, event);
  }, []);
  const handleExitFocusModeLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setExitFocusModeWidth, event);
  }, []);
  const layoutMetrics = useMemo(() => {
    const iconTabWidth = isCompact ? 44 : buttonControlHeight.xs;
    return {
      rowHorizontalInset: 0,
      actionsReservedWidth: iconOnly
        ? 0
        : Math.max(
            0,
            NEW_TAB_ACTION_RESERVED_WIDTH +
              (focusModeEnabled ? exitFocusModeWidth : 0) +
              (showPaneSplitActions ? PANE_SPLIT_ACTIONS_RESERVED_WIDTH : 0) +
              (showPaneMaximizeAction ? PANE_MAXIMIZE_ACTION_RESERVED_WIDTH : 0),
          ),
      rowPaddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
      tabGap: TAB_CHIP_GAP,
      minTabWidth: iconOnly ? iconTabWidth : TAB_MIN_WIDTH,
      maxTabWidth: iconOnly ? iconTabWidth : TAB_MAX_WIDTH,
      tabIconWidth: TAB_ICON_WIDTH,
      tabContentGap: TAB_CONTENT_GAP,
      tabHorizontalPadding: TAB_CHIP_HORIZONTAL_PADDING,
      closeButtonWidth: iconOnly ? 0 : TAB_CLOSE_BUTTON_RESERVED_WIDTH,
    };
  }, [
    exitFocusModeWidth,
    focusModeEnabled,
    showPaneMaximizeAction,
    showPaneSplitActions,
    iconOnly,
    isCompact,
  ]);
  const panePanelKinds = useMemo(() => tabs.map(({ tab }) => tab.kind), [tabs]);
  const fallbackTabLabels = useMemo(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      terminal: t("workspace.tabs.fallback.terminal"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("panels.diff.changesLabel"),
      files: t("panels.files.label"),
      pullRequest: t("panels.pullRequest.label"),
    }),
    [t],
  );
  const tabMenuLabels = useMemo<WorkspaceTabMenuLabels>(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
  const tabLabels = useMemo(
    () =>
      tabs.map((tab) => {
        const label =
          tab.presentation.titleState === "loading"
            ? getFallbackTabLabel(tab.tab, fallbackTabLabels)
            : tab.presentation.label;
        return { key: tab.tab.key, label, modified: tab.presentation.modified };
      }),
    [fallbackTabLabels, tabs],
  );
  const tabLabelSignature = useMemo(() => workspaceTabLabelSignature(tabLabels), [tabLabels]);
  const currentTabLabelKeys = useMemo(() => new Set(tabLabels.map(({ key }) => key)), [tabLabels]);
  useEffect(() => {
    setLabelMeasurements((current) => {
      const removedKeys = [...current.keys()].filter((key) => !currentTabLabelKeys.has(key));
      if (removedKeys.length === 0) {
        return current;
      }
      const next = new Map(current);
      for (const key of removedKeys) {
        next.delete(key);
      }
      return next;
    });
  }, [currentTabLabelKeys]);
  const publishMeasuredTrack = useCallback(() => {
    if (tabsContainerWidth <= 0) {
      return;
    }
    const labelWidths = completeWorkspaceTabLabelWidths(tabLabels, labelMeasurements);
    if (!labelWidths) {
      return;
    }
    setTrackSnapshot((current) => {
      if (
        current?.signature === tabLabelSignature &&
        sameWidths(current.labelWidths, labelWidths)
      ) {
        return current;
      }
      return {
        signature: tabLabelSignature,
        tabs,
        labels: tabLabels,
        labelWidths,
      };
    });
  }, [labelMeasurements, tabLabelSignature, tabLabels, tabs, tabsContainerWidth]);
  useLayoutEffect(() => {
    publishMeasuredTrack();
  }, [publishMeasuredTrack]);
  const handleTabLabelLayout = useCallback(
    (key: string, label: string, event: LayoutChangeEvent) => {
      const width = Math.ceil(event.nativeEvent.layout.width);
      if (width <= 0) {
        return;
      }
      setLabelMeasurements((current) => {
        const measurement = current.get(key);
        if (measurement?.label === label && measurement.width === width) {
          return current;
        }
        const next = new Map(current);
        next.set(key, { label, width });
        return next;
      });
    },
    [],
  );
  const displayedTabs = useMemo(() => {
    if (
      host === "main" &&
      workspaceHasMultiplePanes !== true &&
      tabs.length === 1 &&
      tabs[0].tab.target.kind === "new_tab"
    ) {
      return EMPTY_RESOLVED_TAB_ROWS;
    }
    if (!trackSnapshot) {
      return EMPTY_RESOLVED_TAB_ROWS;
    }
    const currentTabs = new Map(
      tabs.map((tab, index) => [tab.tab.key, { tab, label: tabLabels[index]?.label }]),
    );
    return trackSnapshot.tabs.map((snapshotTab, index) => {
      const current = currentTabs.get(snapshotTab.tab.key);
      return current?.label === trackSnapshot.labels[index]?.label ? current.tab : snapshotTab;
    });
  }, [host, workspaceHasMultiplePanes, tabLabels, tabs, trackSnapshot]);
  const pinnedTabs = useMemo(
    () => (iconOnly ? [] : displayedTabs.filter((item) => item.tab.pinned)),
    [displayedTabs, iconOnly],
  );
  const scrollingTabs = useMemo(
    () => (iconOnly ? displayedTabs : displayedTabs.filter((item) => !item.tab.pinned)),
    [displayedTabs, iconOnly],
  );
  const tabSizing = useMemo(
    () =>
      displayedTabs.map((item): WorkspaceTabSizing => {
        if (!iconOnly && item.tab.pinned)
          return {
            kind: "fit",
            maxWidth: usesFileTabLabel(item.tab.target) ? FILE_TAB_MAX_WIDTH : TAB_MAX_WIDTH,
            trailingWidth: PIN_MARKER_SIZE + TAB_CONTENT_GAP,
          };
        if (iconOnly || !usesFileTabLabel(item.tab.target)) return { kind: "shrink" };
        return {
          kind: "fit",
          maxWidth: FILE_TAB_MAX_WIDTH,
          trailingWidth: isCompact ? 0 : FILE_TAB_TRAILING_WIDTH,
        };
      }),
    [displayedTabs, iconOnly, isCompact],
  );
  const { layout } = useWorkspaceTabLayout({
    tabLabelWidths: trackSnapshot?.labelWidths ?? [],
    tabSizing,
    shrinkToFit: false,
    viewportWidthOverride: tabsContainerWidth > 0 ? tabsContainerWidth : null,
    metrics: layoutMetrics,
    compact: isCompact,
  });
  // A scroll view keeps its offset when its content shrinks under the viewport, so a row that
  // stops scrolling would leave the tabs it had panned past out of view with no way back.
  useEffect(() => {
    if (!layout.requiresHorizontalScrollFallback) {
      tabsScrollRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [layout.requiresHorizontalScrollFallback]);
  const handleDragEnd = useCallback(
    (nextTabs: ResolvedWorkspaceDesktopTabRowItem[]) => {
      let combined = nextTabs;
      if (!iconOnly)
        combined = nextTabs[0]?.tab.pinned
          ? [...nextTabs, ...scrollingTabs]
          : [...pinnedTabs, ...nextTabs];
      onReorderTabs(combined.map((tab) => tab.tab));
    },
    [onReorderTabs, iconOnly, pinnedTabs, scrollingTabs],
  );
  const getTabDragData = useMemo(() => {
    if (!paneId) return undefined;
    return (tab: ResolvedWorkspaceDesktopTabRowItem) => ({
      kind: "workspace-tab" as const,
      paneId,
      tabId: tab.tab.tabId,
    });
  }, [paneId]);
  const createNewTab = useCallback(() => onCreateNewTab({ paneId }), [onCreateNewTab, paneId]);
  const handleNewTabKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (!ownsKeyboardShortcuts) return false;
      if (action.id === "workspace.tab.menu.open") {
        createNewTab();
        return true;
      }
      return false;
    },
    [createNewTab, ownsKeyboardShortcuts],
  );
  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      paneId,
    }),
    actions: ["workspace.tab.menu.open"],
    enabled: ownsKeyboardShortcuts,
    priority: 200,
    handle: handleNewTabKeyboardAction,
  });
  const rail: WorkspaceTabRailSurface = host === "explorer" ? "sidebar" : "surface";
  const onSidebar = rail === "sidebar";
  const renderTab = useCallback(
    ({
      item,
      dragHandleProps,
      isActive,
    }: DraggableRenderItemInfo<ResolvedWorkspaceDesktopTabRowItem>) => {
      const shouldShowCloseButton =
        !iconOnly &&
        !item.tab.pinned &&
        layout.closeButtonPolicy === "all" &&
        (item.presentation.showCloseButton ||
          (item.tab.target.kind === "new_tab" &&
            (displayedTabs.length > 1 || workspaceHasMultiplePanes === true)));
      const index = displayedTabs.findIndex((tab) => tab.tab.key === item.tab.key);
      const layoutItem = layout.items[index] ?? null;
      const resolvedTabWidth = layoutItem?.width ?? 150;
      const showLabel = !iconOnly && (item.tab.pinned || (layoutItem?.showLabel ?? true));
      const showDropIndicatorBefore = activeDragTabId !== null && tabDropPreviewIndex === index;
      const showDropIndicatorAfter =
        activeDragTabId !== null &&
        tabDropPreviewIndex === displayedTabs.length &&
        index === displayedTabs.length - 1;
      return (
        <ResolvedDesktopTabChip
          key={`${item.tab.key}:${item.tab.kind}`}
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          item={item}
          isFocused={isFocused}
          isDragging={isActive}
          index={index}
          tabCount={displayedTabs.length}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          fileRevealActions={fileRevealActions}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTabsToLeft={onCloseTabsToLeft}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          resolvedTabWidth={resolvedTabWidth}
          showLabel={showLabel}
          showCloseButton={shouldShowCloseButton}
          rail={rail}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          labels={tabMenuLabels}
          dragHandleProps={isFixedExplorerTarget(item.tab.target) ? undefined : dragHandleProps}
          showDropIndicatorBefore={showDropIndicatorBefore}
          showDropIndicatorAfter={showDropIndicatorAfter}
        />
      );
    },
    [
      activeDragTabId,
      iconOnly,
      isFocused,
      layout.closeButtonPolicy,
      layout.items,
      normalizedServerId,
      normalizedWorkspaceId,
      onCloseOtherTabs,
      onCloseTab,
      workspaceHasMultiplePanes,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      fileRevealActions,
      onCopyResumeCommand,
      onNavigateTab,
      onReloadAgent,
      onRenameTab,
      rail,
      setHoveredCloseTabKey,
      tabMenuLabels,
      tabDropPreviewIndex,
      displayedTabs,
    ],
  );
  const tabsScrollStyle = useMemo(
    () => [
      styles.tabsScroll,
      layout.requiresHorizontalScrollFallback
        ? styles.tabsScrollOverflow
        : styles.tabsScrollFitContent,
    ],
    [layout.requiresHorizontalScrollFallback],
  );
  const row = (
    <View
      style={[
        styles.tabsContainer,
        styles.tabsContainerDensity(isDenseDesktopTabRail({ isCompact, rail })),
        onSidebar && styles.tabsContainerSidebar,
      ]}
      testID="workspace-tabs-row"
      dataSet={EDITOR_TABS_DATASET}
      onLayout={handleTabsContainerLayout}
    >
      <View
        style={styles.tabLabelMeasurements}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {tabLabels.map(({ key, label }) => (
          <TabLabelMeasurement
            key={`${key}:${label}`}
            tabKey={key}
            label={label}
            onMeasure={handleTabLabelLayout}
          />
        ))}
      </View>
      <WorkspaceExitFocusModeButton
        visible={focusModeEnabled}
        onPress={onExitFocusMode}
        onLayout={handleExitFocusModeLayout}
      />
      {pinnedTabs.length > 0 && (
        <View style={styles.pinnedTabs} testID="workspace-pinned-tabs">
          <SortableInlineList
            data={pinnedTabs}
            keyExtractor={tabKeyExtractor}
            useDragHandle
            disabled={!externalDndContext && pinnedTabs.length < 2}
            onDragEnd={handleDragEnd}
            externalDndContext={externalDndContext}
            activeId={activeDragTabId}
            getItemData={getTabDragData}
            renderItem={renderTab}
          />
        </View>
      )}
      <View style={styles.tabsScrollContainer}>
        <Animated.ScrollView
          ref={tabsScrollRef}
          horizontal
          scrollEnabled={layout.requiresHorizontalScrollFallback}
          testID="workspace-tabs-scroll"
          style={tabsScrollStyle}
          contentContainerStyle={styles.tabsContent}
          showsHorizontalScrollIndicator={false}
          onLayout={tabScrollBoundary.onLayout}
          onContentSizeChange={tabScrollBoundary.onContentSizeChange}
          onScroll={tabScrollBoundary.onScroll}
          scrollEventThrottle={16}
        >
          <SortableInlineList
            data={scrollingTabs}
            keyExtractor={tabKeyExtractor}
            useDragHandle
            disabled={!externalDndContext && scrollingTabs.length < 2}
            onDragEnd={handleDragEnd}
            externalDndContext={externalDndContext}
            activeId={activeDragTabId}
            getItemData={getTabDragData}
            renderItem={renderTab}
          />
        </Animated.ScrollView>
        <HorizontalScrollBoundaryShades
          visible={layout.requiresHorizontalScrollFallback}
          backdrop={rail}
          testIDPrefix="workspace-tabs-scroll-shade"
          leftStyle={tabScrollBoundary.leftShadeStyle}
          rightStyle={tabScrollBoundary.rightShadeStyle}
        />
      </View>
      {!iconOnly ? (
        <WorkspacePaneToolbarActions
          panePanelKinds={panePanelKinds}
          host={host}
          launchPurpose={launchPurpose}
          showSplitActions={showPaneSplitActions}
          showMaximizeAction={showPaneMaximizeAction}
          paneMaximized={paneMaximized}
          serverId={normalizedServerId}
          paneId={paneId}
          newTabShortcutKeys={newTabKeys}
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onTogglePaneMaximized={onTogglePaneMaximized}
        />
      ) : null}
    </View>
  );
  return <RenderProfile id="WorkspaceDesktopTabsRow">{row}</RenderProfile>;
}
function ResolvedDesktopTabChip({
  serverId,
  workspaceId,
  item,
  isFocused,
  isDragging,
  index,
  tabCount,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  fileRevealActions,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  rail,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  labels,
  dragHandleProps,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
}: {
  serverId: string;
  workspaceId: string;
  item: ResolvedWorkspaceDesktopTabRowItem;
  isFocused: boolean;
  isDragging: boolean;
  index: number;
  tabCount: number;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  fileRevealActions?: FileTabRevealActions;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  rail: WorkspaceTabRailSurface;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  labels: WorkspaceTabMenuLabels;
  dragHandleProps: DraggableListDragHandleProps | undefined;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
}) {
  const { t } = useTranslation();
  const presentation = item.presentation;
  const resolvedTab = useMemo(
    () =>
      buildWorkspaceDesktopTabActions({
        tab: item.tab,
        index,
        tabCount,
        onCopyResumeCommand,
        onCopyAgentId,
        onCopyTerminalId,
        onCopyFilePath,
        fileRevealActions,
        onReloadAgent,
        onRenameTab,
        onCloseTab,
        onCloseTabsToLeft,
        onCloseTabsToRight,
        onCloseOtherTabs,
        labels,
      }),
    [
      index,
      item.tab,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      fileRevealActions,
      onCopyResumeCommand,
      labels,
      onReloadAgent,
      onRenameTab,
      tabCount,
    ],
  );
  const rawTooltipLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.tooltip;
  const accessibilityLabel =
    item.tab.target.kind === "agent"
      ? normalizeAgentTooltipTitle(rawTooltipLabel)
      : rawTooltipLabel;
  const tooltipLabel =
    item.tab.target.kind === "agent"
      ? formatAgentTooltipTitle(accessibilityLabel)
      : rawTooltipLabel;
  return (
    <View style={styles.tabSlot}>
      {showDropIndicatorBefore ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
      ) : null}
      <TabChip
        serverId={serverId}
        workspaceId={workspaceId}
        tab={item.tab}
        isActive={item.isActive}
        isDragging={isDragging}
        isFocused={isFocused}
        resolvedTabWidth={resolvedTabWidth}
        showLabel={showLabel}
        showCloseButton={showCloseButton}
        rail={rail}
        isCloseHovered={item.isCloseHovered}
        isClosingTab={item.isClosingTab}
        presentation={presentation}
        tooltipLabel={tooltipLabel}
        accessibilityLabel={accessibilityLabel}
        resolvedTab={resolvedTab}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        dragHandleProps={dragHandleProps}
      />
      {showDropIndicatorAfter ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorAfter]} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "visible",
  },
  tabsContainerSidebar: {
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tabsContainerDensity: (dense: boolean) => ({
    height: dense
      ? WORKSPACE_SECONDARY_HEADER_HEIGHT - theme.spacing[1]
      : WORKSPACE_SECONDARY_HEADER_HEIGHT,
  }),
  tabsScroll: {
    minWidth: 0,
  },
  tabsScrollContainer: {
    minWidth: 0,
    flex: 1,
    alignSelf: "stretch",
  },
  pinnedTabs: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    paddingLeft: TAB_ROW_PADDING_HORIZONTAL,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  tabsScrollFitContent: {
    flex: 1,
  },
  tabsScrollOverflow: {
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
  },
  exitFocusModeSlot: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[0.5],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  paneSplitActions: {
    paddingHorizontal: PANE_SPLIT_ACTIONS_HORIZONTAL_PADDING,
    marginRight: PANE_SPLIT_ACTIONS_OUTER_MARGIN,
  },
  tab: {
    height: TAB_CHIP_HEIGHT,
    paddingHorizontal: TAB_CHIP_HORIZONTAL_PADDING,
    borderRadius: theme.borderRadius.base,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  tabFill: (backdrop: SurfaceBackdrop) => ({
    backgroundColor: theme.colors[backdrop],
  }),
  tabDense: {
    height: TAB_CHIP_HEIGHT - theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  fileTab: (showCloseButton: boolean) => ({
    paddingRight: TAB_CHIP_HORIZONTAL_PADDING + (showCloseButton ? FILE_TAB_TRAILING_WIDTH : 0),
  }),
  explorerTab: { paddingHorizontal: theme.spacing[1] },
  tabLabelPreview: { fontStyle: "italic" },
  tabPin: { flexShrink: 0, width: PIN_MARKER_SIZE, alignItems: "center", justifyContent: "center" },
  tabHoverFrame: {
    position: "relative",
  },
  tabSlot: {
    position: "relative",
    overflow: "visible",
    marginHorizontal: TAB_CHIP_GAP / 2,
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
    userSelect: "none",
  },
  tabIcon: {
    width: TAB_ICON_WIDTH,
    height: TAB_ICON_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // The chip box stops at the slot's padding box, so the gap between two chips runs from
  // -TAB_CHIP_GAP to 0. Centre a TAB_DROP_INDICATOR_WIDTH pill in it.
  tabDropIndicator: {
    position: "absolute",
    top: theme.spacing[0.5],
    bottom: theme.spacing[0.5],
    width: TAB_DROP_INDICATOR_WIDTH,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    pointerEvents: "none",
  },
  tabDropIndicatorBefore: {
    left: -TAB_CHIP_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tabDropIndicatorAfter: {
    right: -TAB_CHIP_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.chrome,
    fontWeight: theme.fontWeight.normal,
    userSelect: "none",
  },
  fileTabLabel: { overflow: "hidden", textOverflow: "clip" },
  tabLabelMeasurements: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
    alignItems: "flex-start",
    pointerEvents: "none",
  },
  tabLabelMeasurement: {
    flexShrink: 0,
  },
  tabLabelSkeleton: {
    width: 96,
    maxWidth: "100%",
    flexShrink: 1,
    minWidth: 0,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.9,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabTrailingOverlay: (isFileLabel: boolean) => ({
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: isFileLabel ? FILE_TAB_TRAILING_WIDTH + TAB_CHIP_HORIZONTAL_PADDING : 48,
    borderTopRightRadius: theme.borderRadius.base,
    borderBottomRightRadius: theme.borderRadius.base,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    overflow: "hidden",
  }),
  tabTrailingOverlayShown: {
    opacity: 1,
  },
  tabTrailingOverlayHidden: {
    opacity: 0,
  },
  tabCloseButton: {
    position: "absolute",
    right: 4,
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  tabModifiedDot: {
    width: TAB_MODIFIED_DOT_SIZE,
    height: TAB_MODIFIED_DOT_SIZE,
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipAgentContent: {
    gap: theme.spacing[0.5],
    maxWidth: 420,
  },
  agentTooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipAgentMetadata: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tooltipAgentId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipAgentSeparator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipAgentActivity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
