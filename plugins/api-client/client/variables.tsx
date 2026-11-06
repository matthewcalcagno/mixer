import {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { PluginTheme } from "@mixer/plugin";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@mixer/plugin/client/ui";
import type { ApiRequest } from "../shared/contracts.js";
import { requestCollection, type ClientState } from "./model.js";
import {
  variableStatus,
  activeVariablePairs,
  variableDefinitions,
  requestVariableNames,
  saveVariable,
  scopeVariables,
} from "./variables-model.js";
import { Dialog } from "./dialogs.js";
import { Action, Field } from "./controls.js";
import { themeStyle } from "./styles.js";
interface VariableContextValue {
  state: ClientState;
  theme: PluginTheme;
  inspect(name: string): void;
}
const VariableContext = createContext<VariableContextValue | null>(null);
export const useRequestVariables = () => useContext(VariableContext);
export function VariableProvider({
  state,
  theme,
  update,
  children,
  rootRef,
  compact,
  rootStyle,
  onKeyDown,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  compact: boolean;
  rootStyle: React.CSSProperties;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  state: ClientState;
  theme: PluginTheme;
  update(change: (current: ClientState) => ClientState): void;
  children: ReactNode;
}) {
  const [inspecting, setInspecting] = useState<string | null>(null);
  const close = useCallback(() => setInspecting(null), []);
  const save = useCallback(
    (name: string, value: string, scopeId: string) => {
      update((current) => saveVariable(current, name, value, scopeId));
      setInspecting(null);
    },
    [update],
  );
  const context = useMemo(() => ({ state, theme, inspect: setInspecting }), [state, theme]);
  return (
    <VariableContext value={context}>
      <div
        className="ac-root"
        ref={rootRef}
        data-compact={compact}
        style={rootStyle}
        data-testid="api-client"
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
      {inspecting !== null && (
        <VariableDialog
          key={inspecting}
          name={inspecting}
          close={close}
          save={save}
          context={context}
        />
      )}
    </VariableContext>
  );
}
function VariableDialog({
  name,
  close,
  save,
  context,
}: {
  name: string;
  close(): void;
  save(name: string, value: string, scopeId: string): void;
  context: VariableContextValue;
}) {
  const form = useRef<HTMLFormElement>(null);
  const saveAction = useCallback(() => form.current?.requestSubmit(), []);
  const status = variableStatus(context.state, name);
  const [scopeId, setScopeId] = useState(status.scopeId);
  const existing = scopeVariables(context.state, scopeId);
  const [value, setValue] = useState(existing.findLast((pair) => pair.key === name)?.value ?? "");
  const collection = requestCollection(context.state, context.state.activeId);
  const active = context.state.environments.find(
    (item) => item.id === context.state.activeEnvironmentId,
  );
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    [],
  );
  const changeScope = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => setScopeId(event.target.value),
    [],
  );
  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      save(name, value, scopeId);
    },
    [name, value, scopeId, save],
  );
  return (
    <Dialog theme={context.theme} title={`Variable: ${name}`} close={close}>
      <form ref={form} className="ac-name-form" onSubmit={submit}>
        {!status.resolved && <p className="ac-variable-error">{status.error}</p>}
        <Field label="Scope">
          <select aria-label="Variable scope" value={scopeId} onChange={changeScope}>
            {active && <option value={active.id}>{active.name} (active environment)</option>}
            {collection && (
              <option value={`collection:${collection.id}`}>{collection.name} (collection)</option>
            )}
            <option value="globals">Globals</option>
          </select>
        </Field>
        <Field label="Value">
          <input
            autoFocus
            aria-label="Variable value"
            value={value}
            onChange={change}
            placeholder="Value or {{anotherVariable}}"
          />
        </Field>
        <p className="ac-muted">
          Environment values override collection variables and globals. Saving enables this
          variable. Values are stored on this device.
        </p>
        <div className="ac-dialog-actions">
          <Action onClick={close}>Cancel</Action>
          <Action primary onClick={saveAction}>
            Save variable
          </Action>
          <button type="submit" className="ac-hidden" tabIndex={-1} aria-hidden="true" />
        </div>
      </form>
    </Dialog>
  );
}
export function VariableToken({
  name,
  children,
  sensitive = false,
}: {
  name: string;
  children: ReactNode;
  sensitive?: boolean;
}) {
  const context = useRequestVariables();
  if (!context) return children;
  const status = variableStatus(context.state, name);
  return (
    <span className="ac-variable-trigger" data-variable={name} data-resolved={status.resolved}>
      <HoverCard>
        <HoverCardTrigger>
          <span>{children}</span>
        </HoverCardTrigger>
        <HoverCardContent placement="bottom" alignment="start">
          <VariablePreview name={name} context={context} sensitive={sensitive} />
        </HoverCardContent>
      </HoverCard>
    </span>
  );
}
function VariablePreview({
  name,
  context,
  sensitive,
}: {
  name: string;
  context: VariableContextValue;
  sensitive: boolean;
}) {
  const status = variableStatus(context.state, name);
  const [revealed, setRevealed] = useState(!sensitive);
  const toggle = useCallback(() => setRevealed((value) => !value), []);
  const inspect = useCallback(() => context.inspect(name), [context, name]);
  const style = useMemo(() => themeStyle(context.theme), [context.theme]);
  const environment = context.state.environments.find(
    (item) => item.id === context.state.activeEnvironmentId,
  );
  const defined = activeVariablePairs(context.state).some(
    (pair) => pair.enabled && pair.key === name,
  );
  const error = defined
    ? status.error
    : "Not defined in the active environment, collection, or globals.";
  return (
    <div className="ac-root ac-variable-preview" style={style}>
      <strong>{`{{${name}}}`}</strong>
      <span className={status.resolved ? "ac-muted" : "ac-variable-error"}>
        {status.resolved ? `Resolved · ${status.source}` : "Unresolved variable"}
      </span>
      {!status.resolved && (
        <span className="ac-muted">
          {environment ? `Active environment: ${environment.name}` : "No environment selected"}
        </span>
      )}
      {status.resolved ? (
        <code>{revealed ? status.value || "(empty value)" : "••••••••"}</code>
      ) : (
        <p>{error}</p>
      )}
      {sensitive && status.resolved && (
        <Action onClick={toggle}>{revealed ? "Hide value" : "Show value"}</Action>
      )}
      <Action onClick={inspect}>{status.resolved ? "Edit variable" : "Set variable"}</Action>
    </div>
  );
}
export function RequestVariableStatus({ request }: { request: ApiRequest }) {
  const context = useRequestVariables();
  if (!context) return null;
  const missing = requestVariableNames(request).filter(
    (name) => !variableStatus(context.state, name).resolved,
  );
  if (!missing.length) return null;
  return (
    <div className="ac-variable-status" role="status">
      <span>
        {missing.length} unresolved variable{missing.length === 1 ? "" : "s"}
      </span>
      {missing.map((name) => (
        <MissingVariable key={name} name={name} inspect={context.inspect} />
      ))}
    </div>
  );
}
function MissingVariable({ name, inspect }: { name: string; inspect(name: string): void }) {
  const edit = useCallback(() => inspect(name), [inspect, name]);
  return <Action onClick={edit}>{`Set {{${name}}}`}</Action>;
}
export function useVariableCompletions() {
  const context = useRequestVariables();
  return useMemo(() => (context ? variableDefinitions(context.state) : []), [context]);
}
