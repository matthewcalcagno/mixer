import { useCallback, useState, type ChangeEvent } from "react";
import type { ApiRequest } from "../shared/contracts.js";
import { useRequestVariables, useVariableCompletions } from "./variables.js";
import { CodeEditor } from "@mixer/plugin/client/ui";
import { Action, FilePicker, PairEditor, type FormPair } from "./controls.js";
const MODES = [
  { value: "none", label: "none" },
  { value: "multipart", label: "form-data" },
  { value: "urlencoded", label: "x-www-form-urlencoded" },
  { value: "raw", label: "raw" },
  { value: "binary", label: "binary" },
] as const;
export function BodyEditor({
  request,
  onChange,
  onError,
}: {
  request: ApiRequest;
  onChange: (request: ApiRequest) => void;
  onError: (error: string) => void;
}) {
  const variables = useVariableCompletions();
  const variableContext = useRequestVariables();
  const body = request.body;
  const [diagnostics, setDiagnostics] = useState<readonly { message: string; line: number }[]>([]);
  const mode = body.type === "json" || body.type === "text" ? "raw" : body.type;
  const update = useCallback(
    (patch: Partial<ApiRequest["body"]>) => onChange({ ...request, body: { ...body, ...patch } }),
    [request, body, onChange],
  );
  const changeMode = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      const rawType = body.rawFormat === "json" || body.type === "json" ? "json" : "text";
      update({ type: value === "raw" ? rawType : (value as ApiRequest["body"]["type"]) });
    },
    [update, body],
  );
  const format = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const rawFormat = event.target.value as NonNullable<ApiRequest["body"]["rawFormat"]>;
      update({ type: rawFormat === "json" ? "json" : "text", rawFormat });
    },
    [update],
  );
  const text = useCallback((value: string) => update({ text: value }), [update]);
  const fields = useCallback((next: FormPair[]) => update({ fields: next }), [update]);
  const file = useCallback((next: ApiRequest["body"]["file"]) => update({ file: next }), [update]);
  const pretty = useCallback(() => {
    try {
      update({ text: JSON.stringify(JSON.parse(body.text), null, 2) });
    } catch {
      onError("Body is not valid JSON. Resolve variable placeholders before formatting.");
    }
  }, [update, body.text, onError]);
  return (
    <div className="ac-body-editor">
      <div className="ac-body-toolbar">
        <div role="radiogroup" aria-label="Body type" className="ac-body-modes">
          {MODES.map((item) => (
            <label key={item.value}>
              <input
                type="radio"
                name={`body-mode-${request.id}`}
                value={item.value}
                checked={mode === item.value}
                onChange={changeMode}
              />
              {item.label}
            </label>
          ))}
        </div>
        {mode === "raw" && (
          <>
            <select
              aria-label="Raw body format"
              value={body.type === "json" ? "json" : (body.rawFormat ?? "text")}
              onChange={format}
            >
              <option value="text">Text</option>
              <option value="javascript">JavaScript</option>
              <option value="json">JSON</option>
              <option value="html">HTML</option>
              <option value="xml">XML</option>
            </select>
            {body.type === "json" && (
              <Action icon="Braces" onClick={pretty}>
                Format
              </Action>
            )}
          </>
        )}
      </div>
      {mode === "raw" && (
        <div className="ac-body-code">
          <CodeEditor
            variables={variables}
            onInspectVariable={variableContext?.inspect}
            label="Request body"
            value={body.text}
            language={body.type === "json" ? "json" : (body.rawFormat ?? "text")}
            onChange={text}
            onDiagnostics={setDiagnostics}
          />
          {body.type === "json" && diagnostics.length > 0 && (
            <div className="ac-code-error" role="status">
              Line {diagnostics[0]?.line}: {diagnostics[0]?.message}
            </div>
          )}
        </div>
      )}
      {(mode === "multipart" || mode === "urlencoded") && (
        <div className="ac-body-fields">
          <PairEditor
            name="field"
            files={mode === "multipart"}
            pairs={body.fields}
            onChange={fields}
            onError={onError}
          />
        </div>
      )}
      {mode === "binary" && (
        <div className="ac-body-fields">
          <FilePicker file={body.file} onChange={file} onError={onError} />
        </div>
      )}
      {mode === "none" && (
        <div className="ac-body-empty ac-muted">This request does not have a body.</div>
      )}
    </div>
  );
}
