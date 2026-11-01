import { View } from "react-native";
import { useEffect, useState } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { useDesktopStartupBlocker } from "@/desktop/startup-readiness";
import { useRetainedPanelActive } from "@/components/retained-panel";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The file tab's loading state. It covers the whole panel, so a panel can render beneath it. */
export function FilePanelLoading() {
  const active = useRetainedPanelActive();
  useDesktopStartupBlocker("Visible file", active);
  const { t } = useTranslation();
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDelayed(true), 200);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={styles.overlay} testID="file-preview-loading">
      {delayed ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("panels.file.loading")}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
}));
