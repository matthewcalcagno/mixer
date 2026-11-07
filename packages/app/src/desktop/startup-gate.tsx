import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type DesktopHostBridge } from "./host";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStoreHydrated } from "@/stores/workspace-layout-store";
import { desktopStartup, useDesktopStartupBlocker } from "./startup-readiness";
import { scheduleStartupReveal, STARTUP_RECOVERY_DELAY_MS } from "./startup-reveal";
function retryStartup() {
  window.location.reload();
}

export function DesktopStartupGate() {
  const host = getDesktopHost();
  return host?.startup ? <NativeStartupGate bridge={host.startup} /> : null;
}
function subscribePanelHydration(listener: () => void) {
  return usePanelStore.persist.onFinishHydration(listener);
}
function panelHydrated() {
  return usePanelStore.persist.hasHydrated();
}
interface NativeStartupGateProps {
  bridge: NonNullable<DesktopHostBridge["startup"]>;
}
function NativeStartupGate({ bridge }: NativeStartupGateProps) {
  const panelsReady = useSyncExternalStore(subscribePanelHydration, panelHydrated, panelHydrated);
  const layoutReady = useWorkspaceLayoutStoreHydrated();
  useDesktopStartupBlocker("Panel layout", !panelsReady || !layoutReady);
  const snapshot = useSyncExternalStore(
    desktopStartup.subscribe,
    desktopStartup.getSnapshot,
    desktopStartup.getSnapshot,
  );
  const [fontsReady, setFontsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const revealed = useRef(false);
  const releaseFonts = useDesktopStartupBlocker("Fonts", !fontsReady);
  const revealFailed = useCallback(
    (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Unable to reveal the desktop window."),
    [],
  );
  useEffect(() => {
    if (snapshot.completed) return;
    let disposed = false;
    void document.fonts.ready
      .then(() => {
        if (disposed) return;
        setFontsReady(true);
        releaseFonts();
        return undefined;
      })
      .catch((cause) => {
        if (disposed) return;
        setError(
          cause instanceof Error ? cause.message : "The interface fonts could not be prepared.",
        );
        setFontsReady(true);
        releaseFonts();
      });
    return () => {
      disposed = true;
    };
  }, [releaseFonts, snapshot.completed]);
  useEffect(() => {
    if (snapshot.completed) return;
    const timer = window.setTimeout(() => setTimedOut(true), STARTUP_RECOVERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot.completed]);
  useEffect(() => {
    if (snapshot.completed) return;
    const failed = error !== null || timedOut;
    if (!failed && snapshot.pending.length > 0) return;
    if (failed && revealed.current && snapshot.pending.length > 0) return;
    return scheduleStartupReveal(() => {
      const current = desktopStartup.getSnapshot();
      if (!failed && (current.pending.length > 0 || current.revision !== snapshot.revision)) return;
      if (current.pending.length === 0) desktopStartup.complete();
      if (revealed.current) return;
      revealed.current = true;
      if (current.pending.length > 0)
        console.warn("[startup] Revealing window while tasks continue", {
          pending: current.pending,
          timeoutMs: STARTUP_RECOVERY_DELAY_MS,
        });
      void bridge.ready().catch(revealFailed);
    });
  }, [bridge, error, snapshot, timedOut, revealFailed]);
  if (snapshot.completed && !error) return null;
  const delayed = timedOut && snapshot.pending.length > 0;
  if (!error && !delayed) return null;
  return (
    <View style={styles.notice} testID="desktop-startup-recovery">
      <Text style={styles.title}>
        {error ? "Unable to prepare the editor" : "Startup is taking longer than expected"}
      </Text>
      <Text style={styles.message}>
        {error ?? `Still preparing: ${snapshot.pending.join(", ")}. You can keep waiting or retry.`}
      </Text>
      <Button variant="outline" onPress={retryStartup}>
        Retry
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  notice: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: theme.spacing[4],
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    zIndex: 100,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
