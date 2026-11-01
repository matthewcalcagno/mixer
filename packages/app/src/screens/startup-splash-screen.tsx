import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { BookOpen, Copy, RotateCw, TriangleAlert } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { getDesktopDaemonLogs, type DesktopDaemonLogs } from "@/desktop/daemon/desktop-daemon";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { openExternalUrl } from "@/utils/open-external-url";
import { useDesktopStartupBlocker } from "@/desktop/startup-readiness";

interface StartupSplashScreenProps {
  bootstrapState?: { splashError: string | null; retry: () => void };
}
function openGithubIssue() {
  void openExternalUrl("https://github.com/matthewcalcagno/mixer/issues/new");
}
function openDocs() {
  void openExternalUrl("https://paseo.sh/docs");
}

/** The window stays hidden during normal startup. Failures keep the existing recovery UI. */
export function StartupSplashScreen({ bootstrapState }: StartupSplashScreenProps) {
  const { t } = useTranslation();
  const isError = bootstrapState !== undefined && bootstrapState.splashError !== null;
  useDesktopStartupBlocker("Initial route", !isError);
  const [logs, setLogs] = useState<DesktopDaemonLogs | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!isError) {
      setLogs(null);
      setLogsError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getDesktopDaemonLogs()
      .then((value) => {
        if (!cancelled) setLogs(value);
        return undefined;
      })
      .catch((cause) => {
        if (!cancelled)
          setLogsError(
            t("startup.logs.loadFailed", {
              message: cause instanceof Error ? cause.message : String(cause),
            }),
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isError, t]);
  const logsText = useMemo(() => {
    if (loading) return t("startup.logs.loading");
    if (logs?.contents) return logs.contents;
    return logsError ?? t("startup.logs.unavailable");
  }, [loading, logs, logsError, t]);
  const copyLogs = useCallback(() => {
    void Clipboard.setStringAsync(logs?.logPath ? `${logs.logPath}\n\n${logs.contents}` : logsText);
  }, [logs, logsText]);
  if (!isError)
    return (
      <View testID="startup-splash" style={styles.container}>
        <TitlebarDragRegion />
      </View>
    );
  return (
    <View style={styles.container} testID="startup-error">
      <TitlebarDragRegion />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.errorContent}>
          <Text style={styles.title}>{t("startup.errorTitle")}</Text>
          <Text style={styles.description}>{t("startup.errorDescription")}</Text>
          <Text dataSet={CODE_SURFACE_DATASET} style={styles.error}>
            {bootstrapState.splashError}
          </Text>
          {logs?.logPath && <Text style={styles.description}>{logs.logPath}</Text>}
          <View style={styles.logsContainer}>
            <ScrollView contentContainerStyle={styles.logsContent}>
              <Text dataSet={CODE_SURFACE_DATASET} selectable style={styles.logs}>
                {logsText}
              </Text>
            </ScrollView>
          </View>
          <View style={styles.actions}>
            <Button variant="secondary" leftIcon={Copy} onPress={copyLogs}>
              Copy logs
            </Button>
            <Button variant="outline" leftIcon={TriangleAlert} onPress={openGithubIssue}>
              Open GitHub issue
            </Button>
            <Button variant="outline" leftIcon={BookOpen} onPress={openDocs}>
              Docs
            </Button>
            <Button variant="default" leftIcon={RotateCw} onPress={bootstrapState.retry}>
              Retry
            </Button>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { position: "relative", flex: 1, backgroundColor: theme.colors.surface0 },
  scroll: { flex: 1, overflowX: "auto", overflowY: "auto" },
  content: {
    flexGrow: 1,
    alignItems: "center",
    padding: theme.spacing[8],
    paddingTop: theme.spacing[16],
  },
  errorContent: { maxWidth: 720, width: "100%", gap: theme.spacing[6] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
    fontFamily: theme.fontFamily.mono,
  },
  logsContainer: {
    height: 200,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  logsContent: { padding: theme.spacing[4] },
  logs: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    lineHeight: 18,
    whiteSpace: "pre",
    overflowWrap: "normal",
  },
  actions: { flexDirection: "row", gap: theme.spacing[3], flexWrap: "wrap" },
}));
