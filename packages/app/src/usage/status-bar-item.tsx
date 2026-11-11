import { WORKSPACE_STATUS_BAR_HEIGHT } from "@/constants/layout";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { useUsageHostId } from "./hosts";
import { useUsageHostReports } from "./queries";
import { UsageSourceIcon } from "./source-icon";
import { UsageMeter } from "./meter";
import {
  choosePinnedUsageLayout,
  METER_GAP,
  MIN_METER_WIDTH,
  resolvePinnedUsage,
  limitPinnedUsage,
  type PinnedUsageLayout,
  type PinnedUsageSource,
} from "./pinned";
import { UsageModal } from "./usage-modal";

/** Each summary window with data on the usage host, under its source; empty while none has. */
function useUsageSummary(): readonly PinnedUsageSource[] {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const preferences = settings.usage;
  const reports = useUsageHostReports(useUsageHostId());
  return useMemo(() => resolvePinnedUsage(reports, preferences, t), [preferences, reports, t]);
}

/** Pinned usage replaces the status-bar icon; the modal remains the entry point for every pin. */
export function UsageStatusBarItem({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const sources = useUsageSummary();
  const openUsage = useOpenUsage();
  if (sources.length === 0) return children;
  return (
    <PinnedUsageTrigger label={t("sidebar.footer.usage")} sources={sources} onPress={openUsage} />
  );
}

const OpenUsageContext = createContext<(() => void) | null>(null);

/**
 * One owner for the Usage trigger and modal: both open the Usage modal over the current screen.
 * The modal mounts on first open and unmounts once it has finished closing, so its host's reports
 * load only while it is shown.
 */
export function UsageRoot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openUsage = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  const closeUsage = useCallback(() => setOpen(false), []);
  const unmountUsage = useCallback(() => setMounted(false), []);

  return (
    <OpenUsageContext.Provider value={openUsage}>
      {children}
      {mounted ? <UsageModal visible={open} onClose={closeUsage} onDismiss={unmountUsage} /> : null}
    </OpenUsageContext.Provider>
  );
}

/** Every Usage entry point sends the same open command. */
export function useOpenUsage(): () => void {
  const openUsage = useContext(OpenUsageContext);
  if (!openUsage) throw new Error("Usage actions must be inside UsageRoot.");
  return openUsage;
}

function pinnedUsageLabel(label: string, sources: readonly PinnedUsageSource[]): string {
  const windows = sources.flatMap((source) => source.windows);
  return `${label}: ${windows.map((window) => window.label).join(", ")}`;
}

function triggerStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered || pressed ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

/**
 * One line: each account's icon, then per window a meter and "31% 5h". Off-screen copies measure
 * the line with labels and with percents alone; the richest layout that fits is shown, and what
 * it leaves out takes no space at all.
 */
function PinnedUsageTrigger({
  label,
  sources,
  onPress,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
}) {
  const { visible, overflow } = limitPinnedUsage(sources, 4);
  const windowCount = visible.reduce((count, source) => count + source.windows.length, 0);
  const width = Math.min(360, windowCount * 78 + visible.length * 24 + (overflow ? 36 : 0));
  const triggerStyles = useMemo(() => ({ width }), [width]);
  const [available, setAvailable] = useState<number | null>(null);
  const [labelsWidth, setLabelsWidth] = useState<number | null>(null);
  const [percentsWidth, setPercentsWidth] = useState<number | null>(null);
  const handleAvailableLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailable(layoutWidth(event));
  }, []);
  const handleLabelsLayout = useCallback((event: LayoutChangeEvent) => {
    setLabelsWidth(layoutWidth(event));
  }, []);
  const handlePercentsLayout = useCallback((event: LayoutChangeEvent) => {
    setPercentsWidth(layoutWidth(event));
  }, []);
  const layout = choosePinnedUsageLayout({
    available,
    labelsWidth,
    percentsWidth,
    windowCount,
  });
  return (
    <PressHighlight
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pinnedUsageLabel(label, sources)}
      style={triggerStyle}
      testID="status-bar-usage"
    >
      <View style={[styles.content, triggerStyles]}>
        <View style={styles.line} onLayout={handleAvailableLayout}>
          <PinnedUsageLine sources={visible} layout={layout} />
        </View>
        {overflow ? (
          <Text style={styles.overflow} testID="status-bar-usage-overflow">
            +{overflow}
          </Text>
        ) : null}
      </View>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        <View style={styles.measured} onLayout={handleLabelsLayout}>
          <PinnedUsageLine sources={visible} layout="labels" measuring />
        </View>
        <View style={styles.measured} onLayout={handlePercentsLayout}>
          <PinnedUsageLine sources={visible} layout="percents" measuring />
        </View>
      </View>
    </PressHighlight>
  );
}

/**
 * The line's items as direct children of one row, so every meter shares the leftover width
 * equally.
 */
function PinnedUsageLine({
  sources,
  layout,
  measuring = false,
}: {
  sources: readonly PinnedUsageSource[];
  layout: PinnedUsageLayout;
  measuring?: boolean;
}) {
  return sources.map((source, sourceIndex) => (
    <Fragment key={source.key}>
      <View
        style={sourceIndex === 0 ? null : styles.sourceGap}
        testID={measuring ? undefined : "status-bar-usage-source"}
      >
        <UsageSourceIcon svg={source.icon} size={14} />
      </View>
      {source.windows.map((window, windowIndex) => {
        const leadStyle = windowIndex === 0 ? styles.iconGap : styles.windowGap;
        return (
          <Fragment key={window.key}>
            {layout === "meters" ? (
              <View style={[styles.meterSlot, leadStyle]}>
                <UsageMeter
                  percent={window.percent}
                  tone={window.tone}
                  quiet
                  style={styles.meter}
                />
              </View>
            ) : null}
            <Text
              style={[styles.percent, layout === "meters" ? null : leadStyle]}
              numberOfLines={1}
              testID={measuring ? undefined : "status-bar-usage-pinned-window"}
            >
              {window.percentText}
              {layout === "percents" || window.shortLabel === "" ? null : (
                <Text style={styles.windowLabel}>{` ${window.shortLabel}`}</Text>
              )}
            </Text>
          </Fragment>
        );
      })}
    </Fragment>
  ));
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    maxWidth: 360,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    // Same row geometry and leading rail as Add project and the footer icons.
    height: WORKSPACE_STATUS_BAR_HEIGHT,

    paddingHorizontal: theme.spacing[2],
  },
  triggerHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  content: { flexDirection: "row", alignItems: "center", minWidth: 0, maxWidth: "100%" },
  overflow: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing[2],
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  // Wide enough that nothing inside wraps or shrinks; each child reports its natural width.
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 10_000,
    opacity: 0,
  },
  measured: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  sourceGap: {
    marginLeft: theme.spacing[3],
  },
  iconGap: {
    marginLeft: theme.spacing[1.5],
  },
  windowGap: {
    marginLeft: theme.spacing[2],
  },
  // Every slot takes an equal share of the leftover width, so the line fills the row.
  meterSlot: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: MIN_METER_WIDTH,
    marginRight: METER_GAP,
  },
  meter: {
    height: 6,
    borderRadius: 3,
  },
  percent: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
  },
}));
