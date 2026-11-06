import { useCallback, type ChangeEvent } from "react";
import { SettingsCard, SettingsRow, SettingsSwitch } from "@mixer/plugin/client/ui";
import type { ApiRequest } from "../shared/contracts.js";

type ToggleKey =
  | "followRedirects"
  | "followOriginalMethod"
  | "forwardAuthorization"
  | "removeReferer"
  | "disableCookieJar";
function RequestToggle({
  request,
  onChange,
  field,
  label,
  hint,
}: {
  request: ApiRequest;
  onChange: (value: ApiRequest) => void;
  field: ToggleKey;
  label: string;
  hint: string;
}) {
  const change = useCallback(
    (value: boolean) => onChange({ ...request, [field]: value }),
    [request, onChange, field],
  );
  return (
    <SettingsSwitch
      label={label}
      hint={hint}
      value={Boolean(request[field])}
      onValueChange={change}
    />
  );
}
export function RequestSettings({
  request,
  onChange,
}: {
  request: ApiRequest;
  onChange: (value: ApiRequest) => void;
}) {
  const timeout = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.valueAsNumber;
      if (Number.isFinite(value))
        onChange({ ...request, timeoutMs: Math.min(120000, Math.max(100, value)) });
    },
    [onChange, request],
  );
  const redirects = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.valueAsNumber;
      if (Number.isFinite(value))
        onChange({ ...request, maxRedirects: Math.min(20, Math.max(0, value)) });
    },
    [onChange, request],
  );
  return (
    <div className="ac-settings">
      <SettingsCard variant="flat">
        <SettingsRow
          label="Request timeout"
          hint="Maximum time to wait for a response, in milliseconds."
        >
          <input
            className="ac-setting-number"
            type="number"
            aria-label="Request timeout"
            min={100}
            max={120000}
            value={request.timeoutMs}
            onChange={timeout}
          />
        </SettingsRow>
        <SettingsRow
          label="SSL certificate verification"
          hint="Certificates are verified for every HTTPS request."
        >
          <span className="ac-muted">Enabled</span>
        </SettingsRow>
        <RequestToggle
          request={request}
          onChange={onChange}
          field="followRedirects"
          label="Automatically follow redirects"
          hint="Follow HTTP 3xx responses to their destination."
        />
        <RequestToggle
          request={request}
          onChange={onChange}
          field="followOriginalMethod"
          label="Follow original HTTP method"
          hint="Preserve the method and body instead of changing POST to GET on 301, 302, or 303 redirects."
        />
        <RequestToggle
          request={request}
          onChange={onChange}
          field="forwardAuthorization"
          label="Forward authentication on redirects"
          hint="Retain Authorization and API-key headers when redirecting to another origin."
        />
        <RequestToggle
          request={request}
          onChange={onChange}
          field="removeReferer"
          label="Remove referer header on redirect"
          hint="Remove the Referer header when following redirects."
        />
        <RequestToggle
          request={request}
          onChange={onChange}
          field="disableCookieJar"
          label="Disable cookie jar"
          hint="Do not send stored cookies or save response cookies for this request."
        />
        <SettingsRow
          label="Maximum number of redirects"
          hint="Stop the request after this many redirects."
        >
          <input
            className="ac-setting-number"
            type="number"
            aria-label="Maximum number of redirects"
            min={0}
            max={20}
            value={request.maxRedirects ?? 10}
            onChange={redirects}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
