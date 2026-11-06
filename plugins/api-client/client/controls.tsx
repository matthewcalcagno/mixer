import {
  useCallback,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type ChangeEvent,
} from "react";
import { Button, PaneHeaderAction } from "@mixer/plugin/client/ui";
import type { Pair, RequestFile } from "../shared/contracts.js";
import { VariableInput } from "./variable-input.js";
import { newPair } from "../shared/request.js";

type ActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onClick?: () => void;
};
export function Action({
  icon,
  children,
  primary = false,
  onClick,
  disabled,
  className,
  size = "xs",
}: ActionProps & { icon?: string; primary?: boolean; size?: "xs" | "sm" }) {
  return (
    <span className={className ?? "ac-action"}>
      <Button
        icon={icon}
        size={size}
        variant={primary ? "default" : "ghost"}
        onPress={onClick}
        disabled={disabled}
      >
        {children}
      </Button>
    </span>
  );
}
export function IconAction({
  icon,
  label,
  onClick,
  disabled,
  "aria-pressed": selected,
}: ActionProps & { icon: string; label: string }) {
  return (
    <span className="ac-icon-button">
      <PaneHeaderAction
        icon={icon}
        label={label}
        onPress={onClick ?? noop}
        disabled={disabled}
        selected={selected === true}
      />
    </span>
  );
}
function noop() {}
function SectionTab<T extends string>({
  tab,
  selected,
  onSelect,
  badge,
  configured = false,
}: {
  configured?: boolean;
  badge?: string;
  tab: T;
  selected: T;
  onSelect: (value: T) => void;
}) {
  const select = useCallback(() => onSelect(tab), [tab, onSelect]);
  return (
    <button
      role="tab"
      aria-label={tab}
      aria-selected={tab === selected}
      type="button"
      onClick={select}
    >
      {tab}
      {(badge === "dot" || configured) && (
        <span className="ac-tab-dot" aria-label={`${tab} configured`} />
      )}
      {badge && badge !== "dot" && <span className="ac-tab-count">({badge})</span>}
    </button>
  );
}
export function SectionTabs<T extends string>({
  tabs,
  selected,
  onSelect,
  label,
  badges,
  configured,
}: {
  configured?: Partial<Record<T, boolean>>;
  badges?: Partial<Record<T, string | undefined>>;
  tabs: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="ac-section-tabs">
      {tabs.map((tab) => (
        <SectionTab
          key={tab}
          tab={tab}
          selected={selected}
          onSelect={onSelect}
          badge={badges?.[tab]}
          configured={configured?.[tab]}
        />
      ))}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="ac-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export async function readRequestFile(file: File): Promise<RequestFile> {
  if (file.size > 2_000_000) throw new Error("Request files must be smaller than 2 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    base64: btoa(binary),
  };
}
export function FilePicker({
  file,
  onChange,
  onError,
  label = "Choose request file",
}: {
  label?: string;
  file: RequestFile | null;
  onChange: (value: RequestFile | null) => void;
  onError: (error: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const choose = useCallback(() => input.current?.click(), []);
  const remove = useCallback(() => onChange(null), [onChange]);
  const selected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.currentTarget.files?.[0];
      if (next)
        void readRequestFile(next)
          .then(onChange)
          .catch((error: unknown) =>
            onError(error instanceof Error ? error.message : "Unable to read file."),
          );
      event.currentTarget.value = "";
    },
    [onChange, onError],
  );
  return (
    <div className="ac-inline">
      <input ref={input} type="file" className="ac-hidden" aria-label={label} onChange={selected} />
      <Action icon="Upload" onClick={choose}>
        {file?.name ?? "Choose file"}
      </Action>
      {file && <IconAction icon="X" label="Remove request file" onClick={remove} />}
    </div>
  );
}
export type FormPair = Pair & { file?: RequestFile };
interface PairRowProps {
  pair: FormPair;
  index: number;
  name: string;
  files: boolean;
  change: (id: string, patch: Partial<FormPair>) => void;
  remove: (id: string) => void;
  onError?: (error: string) => void;
}
function PairRow({ pair, index, name, files, change, remove, onError }: PairRowProps) {
  const toggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => change(pair.id, { enabled: event.target.checked }),
    [change, pair.id],
  );
  const key = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => change(pair.id, { key: event.target.value }),
    [change, pair.id],
  );
  const value = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => change(pair.id, { value: event.target.value }),
    [change, pair.id],
  );
  const erase = useCallback(() => remove(pair.id), [remove, pair.id]);
  const selected = useCallback(
    (file: RequestFile | null) => change(pair.id, { file: file ?? undefined, value: "" }),
    [change, pair.id],
  );
  const failed = useCallback((message: string) => onError?.(message), [onError]);
  return (
    <div className="ac-pair-row">
      <input
        type="checkbox"
        aria-label={`Enable ${name} ${index + 1}`}
        checked={pair.enabled}
        onChange={toggle}
      />
      <VariableInput
        aria-label={`${name} key ${index + 1}`}
        placeholder="Key"
        value={pair.key}
        onChange={key}
      />
      <div className="ac-pair-value">
        {files ? (
          <FilePicker
            file={pair.file ?? null}
            label={`${name} file ${index + 1}`}
            onChange={selected}
            onError={failed}
          />
        ) : (
          <VariableInput
            aria-label={`${name} value ${index + 1}`}
            placeholder="Value or {{variable}}"
            value={pair.value}
            onChange={value}
          />
        )}
      </div>
      <IconAction icon="X" label={`Remove ${name} ${index + 1}`} onClick={erase} />
    </div>
  );
}
export function PairEditor({
  pairs,
  onChange,
  name,
  files = false,
  onError,
  generated,
}: {
  generated?: readonly { name: string; value: string }[];
  pairs: FormPair[];
  onChange: (pairs: FormPair[]) => void;
  name: string;
  files?: boolean;
  onError?: (error: string) => void;
}) {
  const [draft, setDraft] = useState(() => newPair());
  const change = useCallback(
    (id: string, patch: Partial<FormPair>) => {
      if (id === draft.id) {
        setDraft(newPair());
        onChange([...pairs, { ...draft, ...patch }]);
      } else onChange(pairs.map((pair) => (pair.id === id ? { ...pair, ...patch } : pair)));
    },
    [onChange, pairs, draft],
  );
  const remove = useCallback(
    (id: string) => onChange(pairs.filter((pair) => pair.id !== id)),
    [onChange, pairs],
  );
  const add = useCallback(() => onChange([...pairs, newPair()]), [pairs, onChange]);
  return (
    <div className="ac-pair-editor">
      <div className="ac-pair-heading">
        <span />
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {generated?.map((header) => (
        <div className="ac-pair-row ac-generated-header" key={`auto:${header.name}`}>
          <span aria-label="Automatically generated">↳</span>
          <span>{header.name}</span>
          <span>{header.value}</span>
          <span />
        </div>
      ))}
      {[...pairs, draft].map((pair, index) => (
        <PairRow
          key={pair.id}
          pair={pair}
          index={index}
          name={name}
          files={files}
          change={change}
          remove={remove}
          onError={onError}
        />
      ))}
      <Action icon="Plus" onClick={add}>
        Add {name}
      </Action>
    </div>
  );
}
