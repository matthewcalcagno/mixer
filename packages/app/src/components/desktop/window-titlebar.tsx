import { Text, View } from "react-native";
import { useCallback, useMemo } from "react";
import { router, usePathname } from "expo-router";
import { Settings } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { useDesktopWindowTitle } from "@/desktop/window-title";
import { TitlebarDragRegion } from "./titlebar-drag-region";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { buildSettingsRoute } from "@/utils/host-routes";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useCustomDesktopWindowControls } from "@/utils/desktop-window";
import { getDesktopWindowControlsWidth } from "@/desktop/window-chrome-presentation";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import { ICON_SIZE, SPACING } from "@/styles/theme";
import { ApplicationHelpMenu } from "@/components/sidebar/sidebar-help-menu";

const SettingsIcon = withUnistyles(Settings, (theme) => ({ color: theme.colors.foregroundMuted }));

export function useHasDesktopTitlebar(): boolean {
  const isCompact = useIsCompactFormFactor();
  return !isCompact && getIsElectron();
}

export function DesktopWindowTitlebar({ visible }: { visible: boolean }) {
  const pathname = usePathname();
  const title = useDesktopWindowTitle((state) => state.title);
  const hasStandalonePageHeading = pathname.split("/").some((segment) => segment === "settings");
  const showTitle =
    title.length > 0 &&
    pathname !== "/new" &&
    pathname !== "/open-project" &&
    !hasStandalonePageHeading;
  const { t } = useTranslation();
  const shortcut = useShortcutKeys("toggle-settings");
  const controls = useCustomDesktopWindowControls();
  const controlsWidth =
    controls.visible && controls.mode ? getDesktopWindowControlsWidth(controls.mode) : 0;
  const actionStyle = useMemo(
    () => [
      styles.actions,
      {
        right: controlsWidth + SPACING[4] - (smallIconButtonChromeFrameSize() - ICON_SIZE.md) / 2,
      },
    ],
    [controlsWidth],
  );
  const openSettings = useCallback(() => router.push(buildSettingsRoute()), []);
  if (!visible) return <ApplicationHelpMenu />;
  return (
    <View style={styles.bar} testID="desktop-window-titlebar">
      <TitlebarDragRegion />
      {showTitle && (
        <View pointerEvents="none" style={styles.titleFrame}>
          <Text numberOfLines={1} style={styles.title} testID="desktop-window-title">
            {title}
          </Text>
        </View>
      )}
      <View style={actionStyle} testID="desktop-window-settings">
        <ApplicationHelpMenu />
        <ToolbarButton
          label={t("sidebar.actions.settings")}
          onPress={openSettings}
          shortcut={shortcut}
          testID="sidebar-settings"
        >
          <SettingsIcon size={ICON_SIZE.md} />
        </ToolbarButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    position: "relative",
    height: theme.spacing[7],
    flexShrink: 0,
    backgroundColor: theme.colors.background,
    justifyContent: "center",
  },
  titleFrame: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 160,
    right: 160,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    maxWidth: "100%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actions: {
    position: "absolute",
    top: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
  },
}));
