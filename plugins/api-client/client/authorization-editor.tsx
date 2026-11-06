import { useCallback, type ChangeEvent } from "react";
import type { ApiRequest } from "../shared/contracts.js";
import { VariableInput } from "./variable-input.js";
import { Field } from "./controls.js";

function emptyAuth(type: string): ApiRequest["auth"] {
  switch (type) {
    case "bearer":
      return { type, token: "" };
    case "basic":
      return { type, username: "", password: "" };
    case "api-key":
      return { type, key: "X-API-Key", value: "", location: "header" };
    default:
      return { type: "none" };
  }
}
export function AuthorizationEditor({
  request,
  onChange,
}: {
  request: ApiRequest;
  onChange: (value: ApiRequest) => void;
}) {
  const auth = request.auth;
  const type = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onChange({ ...request, auth: emptyAuth(event.target.value) }),
    [request, onChange],
  );
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange({ ...request, auth: { ...auth, [event.target.name]: event.target.value } }),
    [request, auth, onChange],
  );
  return (
    <div className="ac-authorization">
      <div className="ac-auth-type">
        <Field label="Type">
          <select aria-label="Authorization type" value={auth.type} onChange={type}>
            <option value="none">No authorization</option>
            <option value="bearer">Bearer token</option>
            <option value="basic">Basic auth</option>
            <option value="api-key">API key</option>
          </select>
        </Field>
        {auth.type !== "none" && (
          <p className="ac-muted">
            Authorization is added automatically when you send the request.
          </p>
        )}
      </div>
      <div className="ac-auth-fields">
        {auth.type === "none" && (
          <p className="ac-muted">Select an authorization type to configure credentials.</p>
        )}
        {auth.type === "bearer" && (
          <Field label="Token">
            <VariableInput
              type="password"
              name="token"
              aria-label="Bearer token"
              value={auth.token}
              placeholder="Token or {{variable}}"
              onChange={change}
            />
          </Field>
        )}
        {auth.type === "basic" && (
          <>
            <Field label="Username">
              <VariableInput
                name="username"
                aria-label="Auth username"
                value={auth.username}
                onChange={change}
              />
            </Field>
            <Field label="Password">
              <VariableInput
                type="password"
                name="password"
                aria-label="Auth password"
                value={auth.password}
                onChange={change}
              />
            </Field>
          </>
        )}
        {auth.type === "api-key" && (
          <>
            <Field label="Key">
              <VariableInput
                name="key"
                aria-label="API key name"
                value={auth.key}
                onChange={change}
              />
            </Field>
            <Field label="Value">
              <VariableInput
                type="password"
                name="value"
                aria-label="API key value"
                value={auth.value}
                onChange={change}
              />
            </Field>
            <Field label="Add to">
              <select
                name="location"
                aria-label="API key location"
                value={auth.location}
                onChange={change}
              >
                <option value="header">Headers</option>
                <option value="query">Query parameters</option>
              </select>
            </Field>
          </>
        )}
      </div>
    </div>
  );
}
