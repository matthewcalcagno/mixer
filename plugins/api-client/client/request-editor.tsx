import { useState, useCallback, useMemo } from "react";
import type { ApiRequest, Pair } from "../shared/contracts.js";
import { requestParams, withRequestParams } from "../shared/query.js";
import { authFilled, generatedHeaders } from "../shared/headers.js";
import { PairEditor, SectionTabs, Action } from "./controls.js";
import { AuthorizationEditor } from "./authorization-editor.js";
import { BodyEditor } from "./body-editor.js";
import { RequestSettings } from "./request-settings.js";
const REQUEST_TABS = ["Params", "Authorization", "Headers", "Body", "Settings"] as const;
function HeadersEditor({
  request,
  onChange,
}: {
  request: ApiRequest;
  onChange: (value: ApiRequest) => void;
}) {
  const [show, setShow] = useState(false);
  const toggle = useCallback(() => setShow((current) => !current), []);
  const change = useCallback(
    (headers: Pair[]) => onChange({ ...request, headers }),
    [onChange, request],
  );
  const generated = generatedHeaders(request);
  return (
    <>
      <div className="ac-headers-toolbar">
        <span>Headers</span>
        <Action icon={show ? "EyeOff" : "Eye"} onClick={toggle}>
          {show ? "Hide auto-generated headers" : `${generated.length} hidden`}
        </Action>
      </div>
      <PairEditor
        name="header"
        pairs={request.headers}
        onChange={change}
        generated={show ? generated : undefined}
      />
    </>
  );
}
export function RequestEditor({
  request,
  onChange,
  onError,
}: {
  request: ApiRequest;
  onChange: (value: ApiRequest) => void;
  onError: (error: string) => void;
}) {
  const [section, setSection] = useState<(typeof REQUEST_TABS)[number]>("Params");
  const params = useCallback(
    (next: Pair[]) => onChange(withRequestParams(request, next)),
    [onChange, request],
  );
  const count =
    request.headers.filter((header) => header.enabled && header.key).length +
    generatedHeaders(request).length;
  const badges = useMemo(
    () => ({
      Params: requestParams(request).some((pair) => pair.enabled && pair.key) ? "dot" : undefined,
      Authorization: authFilled(request) ? "dot" : undefined,
      Headers: String(count),
      Body: request.body.type !== "none" ? "dot" : undefined,
    }),
    [request, count],
  );
  const configured = useMemo(
    () => ({ Headers: request.headers.some((header) => header.enabled && Boolean(header.key)) }),
    [request.headers],
  );
  return (
    <div className="ac-request-options">
      <SectionTabs
        tabs={REQUEST_TABS}
        selected={section}
        onSelect={setSection}
        label="Request sections"
        badges={badges}
        configured={configured}
      />
      <div key={section} className="ac-editor-content" data-section={section}>
        {section === "Params" && (
          <PairEditor name="parameter" pairs={requestParams(request)} onChange={params} />
        )}
        {section === "Authorization" && (
          <AuthorizationEditor request={request} onChange={onChange} />
        )}
        {section === "Headers" && <HeadersEditor request={request} onChange={onChange} />}
        {section === "Body" && (
          <BodyEditor request={request} onChange={onChange} onError={onError} />
        )}
        {section === "Settings" && <RequestSettings request={request} onChange={onChange} />}
      </div>
    </div>
  );
}
