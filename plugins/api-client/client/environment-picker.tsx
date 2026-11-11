import { useCallback, useMemo, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Icon } from "@mixer/plugin/client/ui";
import type { Environment } from "../shared/contracts.js";

export function EnvironmentPicker({
  environments,
  activeId,
  onChange,
  onCreate,
}: {
  environments: Environment[];
  activeId: string | null;
  onChange: (id: string | null) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const activeName = environments.find((item) => item.id === activeId)?.name ?? "No Environment";
  const options = useMemo(
    () => [{ id: "", name: "No Environment" }, ...environments],
    [environments],
  );
  const visible = useMemo(
    () => options.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase())),
    [options, search],
  );
  const toggle = useCallback(() => {
    setOpen((value) => !value);
    setSearch("");
  }, []);
  const select = useCallback(
    (id: string) => {
      onChange(id || null);
      setOpen(false);
      setSearch("");
    },
    [onChange],
  );
  const changeSearch = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  }, []);
  const keyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setOpen(false);
  }, []);
  const selectEnvironment = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => select(event.currentTarget.dataset.id ?? ""),
    [select],
  );
  const create = useCallback(() => {
    setOpen(false);
    setSearch("");
    onCreate();
  }, [onCreate]);
  return (
    <div className="ac-environment-picker">
      <button
        type="button"
        className="ac-environment-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Environment: ${activeName}`}
        onClick={toggle}
      >
        <span className="ac-truncate">{activeName}</span>
        <Icon name="ChevronDown" size={14} />
      </button>
      {open && (
        <div className="ac-environment-menu">
          <input
            autoFocus
            className="ac-environment-search"
            type="search"
            aria-label="Search environments"
            placeholder="Search"
            value={search}
            onChange={changeSearch}
            onKeyDown={keyDown}
          />
          <div className="ac-environment-options" role="listbox" aria-label="Environment">
            {visible.map((item) => (
              <button
                key={item.id || "none"}
                type="button"
                role="option"
                aria-selected={(activeId ?? "") === item.id}
                className="ac-environment-option"
                data-id={item.id}
                onClick={selectEnvironment}
              >
                <span className="ac-environment-check">
                  {(activeId ?? "") === item.id ? <Icon name="Check" size={16} /> : null}
                </span>
                <span className="ac-truncate">{item.name}</span>
              </button>
            ))}
            {visible.length === 0 && (
              <div className="ac-environment-empty">No environments found</div>
            )}
          </div>
          <button type="button" className="ac-environment-create" onClick={create}>
            <Icon name="Plus" size={17} />
            <span>Create new environment</span>
          </button>
        </div>
      )}
    </div>
  );
}
