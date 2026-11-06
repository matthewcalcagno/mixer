import { useCallback, useState, type ChangeEvent } from "react";
import { Icon } from "@mixer/plugin/client/ui";
import type { PluginTheme } from "@mixer/plugin";
import type { TreeTarget } from "./collection-model.js";
import { CollectionTree } from "./collection-tree.js";
import type { ApiRequest, Environment } from "../shared/contracts.js";
import type { ClientState, Collection, HistoryEntry } from "./model.js";
import { Action, IconAction } from "./controls.js";

const LIBRARY_TABS = ["Collections", "History", "Environments"] as const;
const NAV_ICONS = { Collections: "Folders", History: "History", Environments: "Braces" } as const;
function LibraryNavItem({
  name,
  selected,
  onSelect,
}: {
  name: (typeof LIBRARY_TABS)[number];
  selected: boolean;
  onSelect: (name: (typeof LIBRARY_TABS)[number]) => void;
}) {
  const select = useCallback(() => onSelect(name), [onSelect, name]);
  return (
    <button
      type="button"
      role="tab"
      aria-label={name}
      title={name}
      aria-selected={selected}
      onClick={select}
    >
      <Icon name={NAV_ICONS[name]} size={16} color="currentColor" />
    </button>
  );
}
interface LibraryProps {
  changeCollapsed: (collectionId: string, change: (current: Set<string>) => Set<string>) => void;
  moveResource: (
    sourceId: string,
    target: TreeTarget,
    destinationId: string,
    folderId: string,
  ) => void;
  theme: PluginTheme;
  changeCollection: (collection: Collection) => void;
  duplicateCollection: (collection: Collection) => void;
  state: ClientState;
  environmentChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  close: () => void;
  open: (request: ApiRequest) => void;
  openHistory: (entry: HistoryEntry) => void;
  createCollection: () => void;
  renameCollection: (id: string, name: string) => void;
  deleteCollection: (id: string) => void;
  deleteSaved: (collectionId: string, requestId: string) => void;
  exportCollection: (collection: Collection) => void;
  importRequests: () => void;
  createEnvironment: () => void;
  editEnvironment: (environment: Environment) => void;
  deleteEnvironment: (id: string) => void;
  editGlobals: () => void;
  clearHistory: () => void;
  clearCookies: () => void;
}
function HistoryRow({ entry, open }: { entry: HistoryEntry; open: LibraryProps["openHistory"] }) {
  const select = useCallback(() => open(entry), [open, entry]);
  return (
    <div className="ac-library-row">
      <button type="button" className="ac-history-item" title={entry.request.url} onClick={select}>
        <span className="ac-history-line">
          <span className="ac-method" data-method={entry.request.method}>
            {entry.request.method}
          </span>
          <span className="ac-truncate">{entry.request.url}</span>
        </span>
        <span className="ac-history-details">
          {new Date(entry.at).toLocaleString()} · {entry.error ? "Failed" : entry.status} ·{" "}
          {entry.durationMs} ms
        </span>
      </button>
    </div>
  );
}
function EnvironmentRow({
  environment,
  activeId,
  edit,
  remove,
}: {
  environment: Environment;
  activeId: string | null;
  edit: LibraryProps["editEnvironment"];
  remove: LibraryProps["deleteEnvironment"];
}) {
  const select = useCallback(() => edit(environment), [edit, environment]);
  const erase = useCallback(() => remove(environment.id), [remove, environment.id]);
  return (
    <div className="ac-library-row">
      <button type="button" onClick={select}>
        <Icon name="Braces" size={15} color="currentColor" />
        <span className="ac-truncate">{environment.name}</span>
        {activeId === environment.id && <Icon name="Check" size={14} color="currentColor" />}
      </button>
      <IconAction icon="Trash2" label={`Delete environment ${environment.name}`} onClick={erase} />
    </div>
  );
}
export function Library(props: LibraryProps) {
  const {
    state,
    environmentChange,
    close,
    open,
    openHistory,
    createCollection,
    deleteCollection,
    exportCollection,
    importRequests,
    createEnvironment,
    editEnvironment,
    deleteEnvironment,
    editGlobals,
    clearHistory,
    clearCookies,
  } = props;
  const [tab, setTab] = useState<(typeof LIBRARY_TABS)[number]>("Collections");
  const [search, setSearch] = useState("");
  const changeSearch = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value),
    [],
  );
  const query = search.toLowerCase();
  return (
    <aside className="ac-side" aria-label="API Client library">
      <div className="ac-library-rail">
        <div
          role="tablist"
          aria-label="API Client library sections"
          className="ac-library-navigation"
        >
          {LIBRARY_TABS.map((name) => (
            <LibraryNavItem key={name} name={name} selected={tab === name} onSelect={setTab} />
          ))}
        </div>
        <div className="ac-inline">
          <IconAction icon="Import" label="Import requests" onClick={importRequests} />
          <IconAction icon="PanelRightClose" label="Close API Client library" onClick={close} />
        </div>
      </div>
      <label className="ac-library-context">
        <Icon name="Globe" size={14} color="currentColor" />
        <select
          aria-label="Active environment"
          value={state.activeEnvironmentId ?? ""}
          onChange={environmentChange}
        >
          <option value="">No environment</option>
          {state.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      </label>
      <div className="ac-side-search">
        <span className="ac-search-glyph">
          <Icon name="Search" size={14} color="currentColor" />
        </span>
        <input
          aria-label="Filter API Client library"
          placeholder={`Filter ${tab.toLowerCase()}…`}
          value={search}
          onChange={changeSearch}
        />
      </div>
      <div className="ac-side-toolbar">
        {tab === "Collections" && (
          <>
            <span className="ac-section-label">Collections</span>
            <IconAction icon="FolderPlus" label="New collection" onClick={createCollection} />
          </>
        )}
        {tab === "History" && (
          <>
            <span className="ac-muted">Last {state.history.length} requests</span>
            <IconAction
              icon="Trash2"
              label="Clear request history"
              disabled={!state.history.length}
              onClick={clearHistory}
            />
          </>
        )}
        {tab === "Environments" && (
          <>
            <span className="ac-section-label">Environments</span>
            <IconAction icon="Plus" label="New environment" onClick={createEnvironment} />
          </>
        )}
      </div>
      <div className="ac-side-scroll">
        {tab === "Collections" &&
          state.collections.map((collection) => (
            <CollectionTree
              key={collection.id}
              collection={collection}
              collapsedIds={state.collapsedResources?.[collection.id]}
              changeCollapsed={props.changeCollapsed}
              activeId={state.activeId}
              query={query}
              moveResource={props.moveResource}
              theme={props.theme}
              open={open}
              change={props.changeCollection}
              duplicate={props.duplicateCollection}
              remove={deleteCollection}
              exportCollection={exportCollection}
            />
          ))}
        {tab === "History" &&
          state.history
            .filter((entry) =>
              `${entry.request.name} ${entry.request.url}`.toLowerCase().includes(query),
            )
            .map((entry) => <HistoryRow key={entry.id} entry={entry} open={openHistory} />)}
        {tab === "History" && !state.history.length && (
          <p className="ac-muted">
            Requests appear here after they finish. Select one to open it in a new tab.
          </p>
        )}
        {tab === "Environments" && (
          <>
            <div className="ac-library-row">
              <button type="button" onClick={editGlobals}>
                <Icon name="Globe" size={15} color="currentColor" />
                Global variables<span className="ac-muted">{state.globals.length}</span>
              </button>
            </div>
            {state.environments
              .filter((environment) => environment.name.toLowerCase().includes(query))
              .map((environment) => (
                <EnvironmentRow
                  key={environment.id}
                  environment={environment}
                  activeId={state.activeEnvironmentId}
                  edit={editEnvironment}
                  remove={deleteEnvironment}
                />
              ))}

            <Action icon="Cookie" onClick={clearCookies}>
              Clear cookie jar
            </Action>
          </>
        )}
      </div>
    </aside>
  );
}
