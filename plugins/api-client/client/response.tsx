import type { ComponentProps } from "react";
import { useMemo, useState, useCallback, useEffect } from "react";
import { copyText, CodeEditor, type CodeEditorProps } from "@mixer/plugin/client/ui";
import type { ApiResponse } from "../shared/contracts.js";
import { IconAction, SectionTabs } from "./controls.js";
import { formatMarkup } from "../shared/vendor/format.gen.js";
const RESPONSE_TABS = ["Body", "Headers", "Cookies", "Redirects"] as const;
export interface RequestResult {
  pending: boolean;
  requestId?: string;
  response?: ApiResponse;
  error?: string;
}
export function downloadText(name: string, text: string, type = "application/json") {
  downloadBlob(
    name,
    new Blob([text], {
      type,
    }),
  );
}
function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadResponse(response: ApiResponse) {
  if (response.encoding === "text")
    downloadText("response.txt", response.body, response.contentType || "text/plain");
  else {
    const bytes = Uint8Array.from(atob(response.body), (char) => char.charCodeAt(0));
    downloadBlob(
      "response.bin",
      new Blob([bytes], {
        type: response.contentType || "application/octet-stream",
      }),
    );
  }
}
function responseLanguage(contentType: string): CodeEditorProps["language"] {
  if (/json/i.test(contentType)) return "json";
  if (/html/i.test(contentType)) return "html";
  if (/xml/i.test(contentType)) return "xml";
  if (/javascript/i.test(contentType)) return "javascript";
  if (/css/i.test(contentType)) return "css";
  return "text";
}
function formatBody(response: ApiResponse | undefined, pretty: boolean) {
  if (!response) return "";
  if (response.encoding === "base64") return response.body;
  if (pretty && response.body.length < 1_000_000) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }
  return response.body;
}
function useFormattedBody(response: ApiResponse | undefined, pretty: boolean) {
  const fallback = useMemo(() => formatBody(response, pretty), [response, pretty]);
  const [formatted, setFormatted] = useState<{ response: ApiResponse; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (
      pretty &&
      response?.encoding === "text" &&
      /html/i.test(response.contentType) &&
      response.body.length < 1_000_000
    ) {
      void formatMarkup(response.body)
        .then((text: string) => {
          if (active) setFormatted({ response, text });
          return undefined;
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [response, pretty]);
  return pretty && formatted && formatted.response === response ? formatted.text : fallback;
}
export function ResponseView({
  result,
  onError,
  collapsed = false,
}: {
  collapsed?: boolean;
  result?: RequestResult;
  onError: (value: string) => void;
}) {
  const [tab, setTab] = useState<"Body" | "Headers" | "Cookies" | "Redirects">("Body");
  const [pretty, setPretty] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [search, setSearch] = useState("");
  const response = result?.response;
  const body = useFormattedBody(response, pretty);
  const matches = useMemo(
    () => (search ? body.toLowerCase().split(search.toLowerCase()).length - 1 : 0),
    [body, search],
  );
  const onClickToggleResponseLineWrapping = useCallback<
    NonNullable<ComponentProps<typeof IconAction>["onClick"]>
  >(() => setWrap(!wrap), [setWrap, wrap]);
  const onChangeSearchResponse = useCallback<NonNullable<ComponentProps<"input">["onChange"]>>(
    (event) => setSearch(event.target.value),
    [setSearch],
  );
  const onChangeResponseFormat = useCallback<NonNullable<ComponentProps<"select">["onChange"]>>(
    (event) => setPretty(event.target.value === "pretty"),
    [setPretty],
  );
  const onClickSaveResponse = useCallback<
    NonNullable<ComponentProps<typeof IconAction>["onClick"]>
  >(() => {
    if (response) downloadResponse(response);
  }, [response]);
  const copy = useCallback(() => {
    void copyText(body).catch((error: unknown) =>
      onError(error instanceof Error ? error.message : "Unable to copy response."),
    );
  }, [body, onError]);
  if (!response)
    return (
      <section className="ac-response" data-collapsed={collapsed} aria-label="Response">
        <div className="ac-response-head">
          <SectionTabs
            tabs={RESPONSE_TABS}
            selected={tab}
            onSelect={setTab}
            label="Response sections"
          />
          <span className="ac-muted">{result?.pending ? "Sending…" : "Response"}</span>
        </div>
        <ResponsePlaceholder result={result} />
      </section>
    );
  return (
    <section className="ac-response" aria-label="Response" data-collapsed={collapsed}>
      <div className="ac-response-head">
        <SectionTabs
          tabs={RESPONSE_TABS}
          selected={tab}
          onSelect={setTab}
          label="Response sections"
        />

        <div className="ac-inline ac-response-stats">
          <span
            className="ac-status"
            data-error={response.status >= 400}
            data-testid="api-response-status"
          >
            {response.status} {response.statusText}
          </span>
          <span className="ac-muted">{response.durationMs} ms</span>
          <span className="ac-muted">
            {new Intl.NumberFormat(undefined, {
              maximumFractionDigits: 1,
            }).format(response.bytes / 1024)}{" "}
            KB
          </span>
          <IconAction icon="Download" label="Save response" onClick={onClickSaveResponse} />
        </div>
      </div>
      {response.truncated && <div className="ac-notice">Response limited to the first 5 MB.</div>}
      {tab === "Body" && (
        <>
          <div className="ac-response-tools">
            <div className="ac-inline">
              <select
                aria-label="Response format"
                value={pretty ? "pretty" : "raw"}
                onChange={onChangeResponseFormat}
              >
                <option value="pretty">Pretty</option>
                <option value="raw">Raw</option>
              </select>
              <span className="ac-muted ac-response-type">
                {response.encoding === "base64"
                  ? "Binary · base64"
                  : response.contentType.split(";")[0] || "Text"}
              </span>
            </div>
            <div className="ac-inline">
              <input
                aria-label="Search response"
                placeholder="Find in response"
                value={search}
                onChange={onChangeSearchResponse}
              />
              {search && <span className="ac-muted">{matches} matches</span>}
              <IconAction
                icon="WrapText"
                label="Toggle response line wrapping"
                aria-pressed={wrap}
                onClick={onClickToggleResponseLineWrapping}
              />
              <IconAction icon="Copy" label="Copy response" onClick={copy} />
            </div>
          </div>
          <div
            className="ac-response-body ac-response-code"
            data-wrap={wrap}
            data-testid="api-response-body"
          >
            <CodeEditor
              label="Response body"
              value={body.slice(0, 200000)}
              language={
                response.encoding === "base64" ? "text" : responseLanguage(response.contentType)
              }
              readOnly
              wrap={wrap}
              search={search}
            />
            {body.length > 200000 && (
              <p className="ac-muted">
                Showing the first 200,000 characters. Save the response to inspect the full captured
                body.
              </p>
            )}
          </div>
        </>
      )}
      {tab === "Headers" && (
        <div className="ac-response-body">
          <table className="ac-response-table">
            <tbody>
              {response.headers.map((header) => (
                <tr key={header.name}>
                  <td>{header.name}</td>
                  <td>{header.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "Cookies" && (
        <div className="ac-response-body">
          {response.cookies.length ? (
            <pre>{response.cookies.join("\n\n")}</pre>
          ) : (
            <p className="ac-muted">This response did not set cookies.</p>
          )}
        </div>
      )}
      {tab === "Redirects" && (
        <div className="ac-response-body">
          {response.redirects.length ? (
            <pre>
              {response.redirects
                .map((redirect) => `${redirect.status} ${redirect.url}`)
                .join("\n")}
            </pre>
          ) : (
            <p className="ac-muted">No redirects followed.</p>
          )}
          <p className="ac-muted">Final URL</p>
          <pre>{response.url}</pre>
        </div>
      )}
    </section>
  );
}

function ResponsePlaceholder({ result }: { result?: RequestResult }) {
  if (result?.error)
    return (
      <div className="ac-empty" role="alert">
        <strong>Request failed</strong>
        <span>{result.error}</span>
      </div>
    );
  if (result?.pending)
    return (
      <div className="ac-empty" role="status">
        <strong>Sending request…</strong>
        <span>You can switch tabs while this request runs.</span>
      </div>
    );
  return (
    <div className="ac-empty">
      <strong>Your response will appear here</strong>
      <span>Send a request to inspect its response.</span>
    </div>
  );
}
