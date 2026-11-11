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
import { requestCollection, type ClientState } from "./model.js";
import {
  variableStatus,
  variableDefinitions,
  saveVariable,
  scopeVariables,
} from "./variables-model.js";
import { Action, Field } from "./controls.js";
import { themeStyle } from "./styles.js";
interface VariableContextValue {
  state: ClientState;
  theme: PluginTheme;
  inspect(name: string): void;
  save(name: string, value: string, scopeId: string): void;
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
  const context = useMemo(
    () => ({ state, theme, inspect: setInspecting, save }),
    [state, theme, save],
  );
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
    <div className="ac-root ac-variable-quick-edit" style={themeStyle(context.theme)}>
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
        <div className="ac-dialog-actions">
          <Action onClick={close}>Cancel</Action>
          <Action primary onClick={saveAction}>
            Save variable
          </Action>
          <button type="submit" className="ac-hidden" tabIndex={-1} aria-hidden="true" />
        </div>
      </form>
    </div>
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
  const scopeId = status.scopeId;
  const [value, setValue] = useState(
    scopeVariables(context.state, status.scopeId).findLast((pair) => pair.key === name)?.value ??
      "",
  );
  const style = useMemo(() => themeStyle(context.theme), [context.theme]);
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
    [],
  );
  const commit = useCallback(
    () => context.save(name, value, scopeId),
    [context, name, value, scopeId],
  );
  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    },
    [commit],
  );
  const inspect = useCallback(() => context.inspect(name), [context, name]);
  let scopeLabel = "Environment";
  if (scopeId === "globals") scopeLabel = "Global";
  else if (scopeId.startsWith("collection:")) scopeLabel = "Collection";
  return (
    <div className="ac-root ac-variable-preview" style={style}>
      <div className="ac-inline">
        <input
          aria-label={`Value for ${name}`}
          placeholder="Enter value"
          type={revealed ? "text" : "password"}
          value={value}
          onChange={change}
          onBlur={commit}
          onKeyDown={keyDown}
        />
        {sensitive && <Action onClick={toggle}>{revealed ? "Hide" : "Show"}</Action>}
      </div>
      <div className="ac-variable-footer">
        <span className="ac-variable-scope-icon">{scopeLabel[0]}</span>
        <span className="ac-variable-scope-label">{scopeLabel}</span>
        <button type="button" className="ac-variable-request-link" onClick={inspect}>
          Variables in request →
        </button>
      </div>
    </div>
  );
}

export function useVariableCompletions() {
  const context = useRequestVariables();
  return useMemo(() => (context ? variableDefinitions(context.state) : []), [context]);
}
