import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import type { PreparedWorkspaceEdit, WorkspaceDocuments } from "./documents";
import type { ReviewEdit } from "./workspace-edit";
import { editorEventSchema, type EditorCommand, type MonacoTheme } from "./monaco/messages";
import { useAppSettings } from "@/hooks/use-settings";

interface PendingReview {
  plan: PreparedWorkspaceEdit;
  resolve(applied: boolean): void;
}

export function useWorkspaceEditReview(store: WorkspaceDocuments, theme: MonacoTheme) {
  const [pending, setPending] = useState<PendingReview | null>(null);
  const active = useRef<PendingReview | null>(null);
  const preparing = useRef(false);
  const mounted = useRef(true);
  const finish = useCallback((applied: boolean) => {
    active.current?.resolve(applied);
    active.current = null;
    setPending(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.resolve(false);
      active.current = null;
    };
  }, []);
  const review = useCallback(
    async (input: ReviewEdit): Promise<boolean> => {
      if (active.current || preparing.current)
        throw new Error("Finish the current edit review first.");
      preparing.current = true;
      try {
        const plan = await store.prepare(input.label, input.edits);
        if (input.move) {
          const document = input.move.document;
          await document.ready();
          if (!plan.changes.some((change) => change.document === document)) {
            const snapshot = document.model.getSnapshot();
            plan.changes.push({
              document,
              version: snapshot.version,
              before: snapshot.content,
              after: snapshot.content,
            });
          }
          plan.move = input.move;
        }
        if (plan.changes.length === 0) return true;
        if (!mounted.current) return false;
        return new Promise<boolean>((resolve) => {
          const next = { plan, resolve };
          active.current = next;
          setPending(next);
        });
      } finally {
        preparing.current = false;
      }
    },
    [store],
  );
  return {
    review,
    dialog: pending ? (
      <WorkspaceEditReview
        key={pending.plan.label}
        plan={pending.plan}
        store={store}
        theme={theme}
        onFinish={finish}
      />
    ) : null,
  };
}

function WorkspaceEditReview({
  plan,
  store,
  theme,
  onFinish,
}: {
  plan: PreparedWorkspaceEdit;
  store: WorkspaceDocuments;
  theme: MonacoTheme;
  onFinish(applied: boolean): void;
}) {
  const [selected, setSelected] = useState(0);
  const [previewReady, setPreviewReady] = useState(false);
  const applyingRef = useRef(false);
  const appliedRef = useRef(false);
  const pane = usePaneContext();
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "applying" }
    | { kind: "saving" }
    | { kind: "error"; message: string }
    | { kind: "save-error"; message: string }
  >({ kind: "idle" });
  const change = plan.changes[selected];
  useEffect(() => {
    const check = () => {
      if (applyingRef.current || appliedRef.current) return;
      for (const item of plan.changes) {
        const snapshot = item.document.model.getSnapshot();
        if (snapshot.version !== item.version || snapshot.conflict || snapshot.status === "error") {
          setStatus({
            kind: "error",
            message:
              "A file changed during review. Cancel and request the refactor again. No edits were applied.",
          });
          return;
        }
      }
    };
    const stops = plan.changes.map((item) => item.document.model.subscribe(check));
    check();
    return () => {
      for (const stop of stops) stop();
    };
  }, [plan]);
  const apply = useCallback(async () => {
    applyingRef.current = true;
    setStatus({ kind: "applying" });
    try {
      if (!appliedRef.current) {
        await store.apply(plan);
        appliedRef.current = true;
      }
      setStatus({ kind: "saving" });
      await Promise.all(plan.changes.map((item) => item.document.model.save()));
      const unsaved = plan.changes.filter((item) => item.document.model.getSnapshot().modified);
      if (unsaved.length > 0) {
        const files = unsaved.length === 1 ? "file" : "files";
        setStatus({
          kind: "save-error",
          message: `Changes are in the buffers, but ${unsaved.length} ${files} could not be saved. Open the unsaved files to resolve their conflicts or retry saving.`,
        });
        return;
      }
      onFinish(true);
    } catch (error) {
      setStatus({
        kind: appliedRef.current ? "save-error" : "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      applyingRef.current = false;
    }
  }, [store, plan, onFinish]);
  const applying = status.kind === "applying" || status.kind === "saving";
  const close = useCallback(() => {
    if (!applying) onFinish(appliedRef.current);
  }, [applying, onFinish]);
  const openUnsaved = useCallback(() => {
    for (const item of plan.changes) {
      if (item.document.model.getSnapshot().modified)
        pane.openFileInWorkspace({
          disposition: "main",
          location: { path: item.document.path.slice(store.root.length + 1) },
        });
    }
    onFinish(true);
  }, [pane, plan, store.root, onFinish]);
  let actionLabel = "Apply changes";
  if (status.kind === "saving") actionLabel = "Saving…";
  else if (applying) actionLabel = "Applying…";
  else if (status.kind === "save-error") actionLabel = "Retry saving";
  const header = useMemo(
    () => ({
      title: plan.label,
      subtitle: (
        <Text style={styles.subtitle}>
          {plan.move
            ? `${plan.move.from.slice(store.root.length + 1)} → ${plan.move.to.slice(store.root.length + 1)}`
            : `${plan.changes.length} affected ${plan.changes.length === 1 ? "file" : "files"}`}
        </Text>
      ),
    }),
    [plan, store.root],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {status.kind === "error" || status.kind === "save-error" ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {status.message}
          </Text>
        ) : null}
        {status.kind === "save-error" ? (
          <Button variant="outline" size="sm" onPress={openUnsaved}>
            Open unsaved files
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" disabled={applying} onPress={close}>
          {status.kind === "save-error" ? "Close review" : "Cancel"}
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={applying || status.kind === "error" || !previewReady}
          onPress={apply}
        >
          {actionLabel}
        </Button>
      </View>
    ),
    [status, applying, close, apply, previewReady, actionLabel, openUnsaved],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={1200}
      desktopHeight="85%"
      scrollable={false}
      contentStyle={styles.content}
      testID="workspace-edit-review"
      footer={footer}
    >
      <View style={styles.files}>
        {plan.changes.map((item, index) => (
          <ReviewFileButton
            key={item.document.path}
            path={item.document.path.slice(store.root.length + 1)}
            index={index}
            selected={selected}
            onSelect={setSelected}
          />
        ))}
      </View>
      {change ? (
        <ReviewDiff
          filename={change.document.path}
          before={change.before}
          after={change.after}
          theme={theme}
          onReady={setPreviewReady}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function ReviewFileButton({
  path,
  index,
  selected,
  onSelect,
}: {
  path: string;
  index: number;
  selected: number;
  onSelect(index: number): void;
}) {
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  return (
    <Button variant={index === selected ? "secondary" : "ghost"} size="xs" onPress={select}>
      {path}
    </Button>
  );
}

function ReviewDiff({
  filename,
  before,
  after,
  theme,
  onReady,
}: {
  filename: string;
  before: string;
  after: string;
  theme: MonacoTheme;
  onReady(ready: boolean): void;
}) {
  const { settings } = useAppSettings();
  const frame = useRef<HTMLIFrameElement>(null);
  const booted = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const retry = useCallback(() => {
    booted.current = false;
    setError(null);
    setAttempt((value) => value + 1);
  }, []);
  const current = useRef({ filename, before, after, theme, preferences: settings.editor });
  current.current = { filename, before, after, theme, preferences: settings.editor };
  const send = useCallback(() => {
    const command: EditorCommand = { type: "review", ...current.current };
    frame.current?.contentWindow?.postMessage(command, window.location.origin);
  }, []);
  useEffect(() => {
    onReady(false);
    const timer = window.setTimeout(
      () => setError("The diff preview did not finish loading."),
      30_000,
    );
    function receive(event: MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      const parsed = editorEventSchema.safeParse(event.data);
      if (parsed.success && parsed.data.type === "booted") {
        booted.current = true;
        send();
      }
      if (parsed.success && parsed.data.type === "ready") {
        window.clearTimeout(timer);
        onReady(true);
      }
      if (parsed.success && parsed.data.type === "error") {
        window.clearTimeout(timer);
        onReady(false);
        setError(parsed.data.message);
      }
    }
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [send, attempt, onReady]);
  useEffect(() => {
    if (booted.current) send();
  }, [filename, before, after, theme, send, settings.editor]);
  return (
    <div style={DIFF_CONTAINER_STYLE}>
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- Same trusted bundled runtime as the source editor. */}
      <iframe
        data-mixer-editor=""
        key={attempt}
        ref={frame}
        title="Refactor diff"
        src="/monaco/index.html"
        style={DIFF_STYLE}
      />
      {error ? (
        <div role="alert">
          {error}
          <Button onPress={retry}>Retry diff preview</Button>
        </div>
      ) : null}
    </div>
  );
}

const DIFF_STYLE = { border: "none", flex: 1, minHeight: 240, width: "100%" } as const;
const DIFF_CONTAINER_STYLE = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
} as const;
const styles = StyleSheet.create((theme) => ({
  content: { flex: 1, minHeight: 0 },
  files: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  error: { flex: 1, color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
