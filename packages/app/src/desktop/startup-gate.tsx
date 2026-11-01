import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type DesktopHostBridge } from "./host";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStoreHydrated } from "@/stores/workspace-layout-store";
import { desktopStartup, useDesktopStartupBlocker } from "./startup-readiness";
import { editorEventSchema } from "@/file-panels/source/editor/monaco/messages";

const WARMUP_FRAME_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  left: -10000,
  top: 0,
  opacity: 0,
  pointerEvents: "none",
};
const STARTUP_RECOVERY_DELAY_MS = 90000;
function retryStartup() {
  window.location.reload();
}

export function DesktopStartupGate() {
  const host = getDesktopHost();
  return host?.startup ? (
    <NativeStartupGate bridge={host.startup} isLinux={host.platform === "linux"} />
  ) : null;
}
function subscribePanelHydration(listener: () => void) {
  return usePanelStore.persist.onFinishHydration(listener);
}
function panelHydrated() {
  return usePanelStore.persist.hasHydrated();
}
interface NativeStartupGateProps {
  bridge: NonNullable<DesktopHostBridge["startup"]>;
  isLinux: boolean;
}
function NativeStartupGate({ bridge, isLinux }: NativeStartupGateProps) {
  const panelsReady = useSyncExternalStore(subscribePanelHydration, panelHydrated, panelHydrated);
  const layoutReady = useWorkspaceLayoutStoreHydrated();
  useDesktopStartupBlocker("Panel layout", !panelsReady || !layoutReady);
  const snapshot = useSyncExternalStore(
    desktopStartup.subscribe,
    desktopStartup.getSnapshot,
    desktopStartup.getSnapshot,
  );
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const revealed = useRef(false);
  const releaseRuntime = useDesktopStartupBlocker("Monaco runtime", !runtimeReady);
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
    // Linux compositors may withhold frames until show(). DOM commits still complete while hidden.
    const schedule = (callback: () => void) =>
      isLinux ? window.setTimeout(callback, 0) : requestAnimationFrame(callback);
    let raf = schedule(() => {
      raf = schedule(() => {
        const current = desktopStartup.getSnapshot();
        if (!failed && (current.pending.length > 0 || current.revision !== snapshot.revision))
          return;
        if (current.pending.length === 0) desktopStartup.complete();
        if (revealed.current) return;
        revealed.current = true;
        void bridge.ready().catch(revealFailed);
      });
    });
    return () => {
      if (isLinux) window.clearTimeout(raf);
      else cancelAnimationFrame(raf);
    };
  }, [bridge, error, snapshot, timedOut, revealFailed, isLinux]);
  useLayoutEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      const parsed = editorEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "booted" || parsed.data.type === "error") {
        if (parsed.data.type === "error") setError(parsed.data.message);
        setRuntimeReady(true);
        releaseRuntime();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [releaseRuntime]);
  const warmupFailed = useCallback(() => {
    setError("The bundled editor could not be loaded.");
    setRuntimeReady(true);
    releaseRuntime();
  }, [releaseRuntime]);
  if (snapshot.completed && !error) return null;
  const delayed = timedOut && snapshot.pending.length > 0;
  return (
    <>
      {!runtimeReady && (
        // oxlint-disable-next-line react/iframe-missing-sandbox -- Trusted bundled editor runtime requires the app origin, matching the source editor iframe.
        <iframe
          ref={frame}
          src="/monaco/index.html"
          style={WARMUP_FRAME_STYLE}
          tabIndex={-1}
          aria-hidden="true"
          title="Prepare editor"
          onError={warmupFailed}
          data-testid="desktop-startup-monaco"
        />
      )}
      {(error || delayed) && (
        <View style={styles.notice} testID="desktop-startup-recovery">
          <Text style={styles.title}>
            {error ? "Unable to prepare the editor" : "Startup is taking longer than expected"}
          </Text>
          <Text style={styles.message}>
            {error ??
              `Still preparing: ${snapshot.pending.join(", ")}. You can keep waiting or retry.`}
          </Text>
          <Button variant="outline" onPress={retryStartup}>
            Retry
          </Button>
        </View>
      )}
    </>
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
