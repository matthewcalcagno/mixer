import { useCallback } from "react";
import type { SourceEditorProps } from "@mixer/plugin/client/ui";
import { CodeEditor } from "./code-editor";

/** Browser fallback keeps the same filename-driven editing contract. */
export function SourceEditor({
  filename,
  value,
  onChange,
  onSave,
  readOnly,
  autoFocus,
}: SourceEditorProps) {
  const language = /\.json$/i.test(filename) ? "json" : "text";
  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
      }
    },
    [onSave],
  );
  return (
    <div onKeyDown={keyDown} style={frameStyle}>
      <CodeEditor
        filename={filename}
        autoFocus={autoFocus}
        language={language}
        value={value}
        onChange={onChange}
        label={`Source for ${filename}`}
        readOnly={readOnly}
      />
    </div>
  );
}
const frameStyle = { height: "100%", minHeight: 0 };
