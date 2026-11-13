import { useCallback, useEffect, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { SourceEditorProps } from "@mixer/plugin/client/ui";
import {
  editorEventSchema,
  type EditorConfiguration,
  type MonacoTheme,
} from "@/file-panels/source/editor/monaco/messages";
import { useAppSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";

function Editor(props: SourceEditorProps & { theme: MonacoTheme }) {
  const { settings } = useAppSettings();
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef({ props, settings });
  current.current = { props, settings };
  const revision = useRef(0);
  const version = useRef(0);
  const accepted = useRef(props.value);
  const ready = useRef(false);
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const appearanceKey = JSON.stringify([
    props.theme,
    settings.editor,
    settings.vimKeybindings,
    props.readOnly,
  ]);
  const configure = useCallback(() => {
    const values = current.current;
    const configuration: EditorConfiguration = {
      filename: values.props.filename,
      content: values.props.value,
      revision: revision.current,
      bufferVersion: version.current,
      lineSeparator: lineSeparator(values.props.value),
      theme: values.props.theme,
      vimEnabled: values.settings.vimKeybindings,
      preferences: {
        ...values.settings.editor,
        gitBlame: false,
        gitCodeLens: false,
        gitHover: false,
      },
      projectLanguageServices: false,
      historyOwner: "editor",
      readOnly: values.props.readOnly,
      viewState: null,
      gitAnnotations: false,
    };
    frame.current?.contentWindow?.postMessage(
      { type: "configure", configuration },
      window.location.origin,
    );
  }, []);
  useEffect(() => {
    revision.current = 0;
    version.current = 0;
    const timer = window.setTimeout(
      () => setError("The source editor did not finish loading. Retry to load its local assets."),
      30_000,
    );
    function receive(event: MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      const parsed = editorEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      switch (message.type) {
        case "booted":
          setBooted(true);
          configure();
          break;
        case "ready":
          window.clearTimeout(timer);
          setError("");
          if (!ready.current && current.current.props.autoFocus)
            frame.current?.contentWindow?.postMessage({ type: "focus" }, window.location.origin);
          ready.current = true;
          break;
        case "change":
          revision.current = message.revision;
          version.current = message.baseVersion + 1;
          accepted.current = message.content;
          current.current.props.onChange(message.content);
          break;
        case "save":
          current.current.props.onSave();
          break;
        case "error":
          setError(message.message);
          break;
      }
    }
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [configure, attempt]);
  useEffect(() => {
    if (booted) configure();
  }, [booted, appearanceKey, configure]);
  useEffect(() => {
    if (ready.current && props.autoFocus)
      frame.current?.contentWindow?.postMessage({ type: "focus" }, window.location.origin);
  }, [props.autoFocus]);
  useEffect(() => {
    if (!booted || props.value === accepted.current) return;
    accepted.current = props.value;
    revision.current += 1;
    version.current += 1;
    frame.current?.contentWindow?.postMessage(
      {
        type: "content",
        content: props.value,
        revision: revision.current,
        bufferVersion: version.current,
        lineSeparator: lineSeparator(props.value),
      },
      window.location.origin,
    );
  }, [booted, props.value]);
  const retry = useCallback(() => {
    ready.current = false;
    setError("");
    setBooted(false);
    setAttempt((value) => value + 1);
  }, []);
  return (
    <div style={containerStyle} data-mixer-editor data-testid="plugin-source-editor">
      {error && (
        <div role="alert">
          {error}{" "}
          <Button size="xs" variant="ghost" onPress={retry}>
            Retry
          </Button>
        </div>
      )}
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- Trusted bundled Monaco runtime, shared with the workspace file editor. */}
      <iframe
        key={attempt}
        ref={frame}
        src="/monaco/index.html"
        title={`Source for ${props.filename}`}
        style={frameStyle}
      />
    </div>
  );
}
const containerStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
} as const;
const frameStyle = { flex: 1, width: "100%", minHeight: 0, border: 0 };
function lineSeparator(value: string): "\n" | "\r\n" | "\r" {
  if (value.includes("\r\n")) return "\r\n";
  if (value.includes("\r")) return "\r";
  return "\n";
}
function appearance(theme: Theme) {
  return {
    theme: {
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
    },
  };
}
export const SourceEditor = withUnistyles(Editor, appearance);
