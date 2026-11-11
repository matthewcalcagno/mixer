import type { ComponentProps } from "react";
import { useCallback, useMemo, useState, useRef, useLayoutEffect, useEffect } from "react";
import {
  copyText,
  confirmDialog,
  useToast,
  WorkspaceIsland,
  WorkspaceLayout,
  WorkspaceSidebar,
  Icon,
  ContextMenu,
} from "@mixer/plugin/client/ui";
import type { PluginScreenProps } from "@mixer/plugin/client";
import type { ApiRequest, Environment } from "../shared/contracts.js";
import { withRequestUrl } from "../shared/query.js";
import { newRequest } from "../shared/request.js";
import { VariableInput } from "./variable-input.js";
import { VariableProvider } from "./variables.js";
import { useClientStore } from "./store.js";
import {
  closeRequests,
  tabsToClose,
  needsDiscardConfirmation,
  type CloseTabsMode,
  isModified,
  openRequest,
  openHistoryRequest,
  requestCollection,
  replaceRequest,
  type HistoryEntry,
  saveToCollection,
  removeSavedRequest,
} from "./model.js";
import {
  cloneCollection,
  replaceCollection,
  collectionBreadcrumb,
  moveCollectionResource,
  type TreeTarget,
} from "./collection-model.js";
import { collectionSchema, type Collection } from "./model.js";
import { useRequests } from "./use-requests.js";
import { Action, IconAction } from "./controls.js";
import { RequestWorkspace } from "./request-workspace.js";
import { downloadText } from "./response.js";
import { Library } from "./library.js";
import { EnvironmentPicker } from "./environment-picker.js";
import { EnvironmentDialog, ImportDialog, SaveDialog, NameDialog } from "./dialogs.js";
import { toCurl } from "./import-export.js";
import { css, themeStyle } from "./styles.js";
export function ApiClientScreen(props: PluginScreenProps) {
  return <ApiClient key={props.host.id} {...props} />;
}
function ApiClient({ theme, host, layout }: PluginScreenProps) {
  const { state, update, storageError } = useClientStore(host.id);
  const [notice, setNoticeState] = useState<{ text: string; error: boolean } | null>(null);
  const toast = useToast();
  const setNotice = useCallback(
    (next: { text: string; error: boolean } | null) => {
      if (next && !next.error) {
        toast.show(next.text, { variant: "success" });
        setNoticeState(null);
      } else setNoticeState(next);
    },
    [toast],
  );
  const error = useCallback(
    (text: string) =>
      setNotice({
        text,
        error: true,
      }),
    [setNotice],
  );
  const root = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const [narrow, setNarrow] = useState(false);
  const compact = layout.compact || narrow;
  const [sideOpen, setSideOpen] = useState(!layout.compact);
  useLayoutEffect(() => {
    if (!root.current) return;
    let wasNarrow = false;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = entry.contentRect.width < 800;
      setNarrow(next);
      if (next && !wasNarrow) setSideOpen(false);
      wasNarrow = next;
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState<ApiRequest | null>(null);
  const [environmentDialog, setEnvironmentDialog] = useState<Environment | "globals" | null>(null);
  const [columns, setColumns] = useState(false);
  const toggleLayout = useCallback(() => setColumns((current) => !current), []);
  const setConfirmation = useCallback(
    (confirmation: { title: string; description: string; action: () => void }) => {
      const close = confirmation.title.startsWith("Close");
      void confirmDialog({
        title: confirmation.title,
        message: confirmation.description,
        confirmLabel: close ? "Discard changes" : confirmation.title.replace(/\?$/, ""),
        destructive: true,
      })
        .then((accepted) => {
          if (accepted) confirmation.action();
          return undefined;
        })
        .catch((cause: unknown) =>
          error(cause instanceof Error ? cause.message : "Unable to open confirmation."),
        );
    },
    [error],
  );
  const styles = useMemo(() => themeStyle(theme), [theme]);
  const { run, stop, forget, results } = useRequests(state, update, error);
  const active = state.tabs.find((request) => request.id === state.activeId) ?? state.tabs[0]!;
  const result = results[active.id];
  const tabIds = useMemo(() => state.tabs.map((tab) => tab.id), [state.tabs]);
  const savedCollection = requestCollection(state, active.id);
  const collectionName = collectionBreadcrumb(savedCollection, active.id);
  const change = useCallback(
    (request: ApiRequest) => update((current) => replaceRequest(current, request)),
    [update],
  );
  const onSaveEnvironmentDialog = useCallback<
    NonNullable<ComponentProps<typeof EnvironmentDialog>["onSave"]>
  >(
    (environment) => {
      if (environmentDialog === "globals")
        update((current) => ({
          ...current,
          globals: environment.variables,
        }));
      else
        update((current) => ({
          ...current,
          activeEnvironmentId: current.environments.some((entry) => entry.id === environment.id)
            ? current.activeEnvironmentId
            : environment.id,
          environments: [
            ...current.environments.filter((entry) => entry.id !== environment.id),
            environment,
          ],
        }));
    },
    [environmentDialog, update],
  );
  const closeEnvironmentDialog = useCallback<
    NonNullable<ComponentProps<typeof EnvironmentDialog>["close"]>
  >(() => setEnvironmentDialog(null), [setEnvironmentDialog]);
  const closeSaveDialog = useCallback<NonNullable<ComponentProps<typeof SaveDialog>["close"]>>(
    () => setSaving(null),
    [setSaving],
  );
  const onImportImportDialog = useCallback<
    NonNullable<ComponentProps<typeof ImportDialog>["onImport"]>
  >(
    (collection) => {
      update((current) => ({
        ...current,
        collections: [...current.collections, collection],
      }));
      setSideOpen(true);
      setNotice({
        text: `Imported ${collection.requests.length} requests`,
        error: false,
      });
    },
    [update, setSideOpen, setNotice],
  );
  const closeImportDialog = useCallback<NonNullable<ComponentProps<typeof ImportDialog>["close"]>>(
    () => setImporting(false),
    [setImporting],
  );
  const clearCookiesLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["clearCookies"]>
  >(() => {
    update((current) => ({
      ...current,
      cookieJar: "",
    }));
    setNotice({
      text: "Cookie jar cleared",
      error: false,
    });
  }, [update, setNotice]);
  const clearHistoryLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["clearHistory"]>
  >(
    () =>
      setConfirmation({
        title: "Clear history?",
        description: "The last 100 requests will be removed from history.",
        action: () =>
          update((current) => ({
            ...current,
            history: [],
          })),
      }),
    [setConfirmation, update],
  );
  const editGlobalsLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["editGlobals"]>
  >(() => setEnvironmentDialog("globals"), [setEnvironmentDialog]);
  const deleteEnvironmentLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["deleteEnvironment"]>
  >(
    (id) =>
      setConfirmation({
        title: "Delete environment?",
        description: "This environment and its variables will be removed.",
        action: () =>
          update((current) => ({
            ...current,
            environments: current.environments.filter((environment) => environment.id !== id),
            activeEnvironmentId:
              current.activeEnvironmentId === id ? null : current.activeEnvironmentId,
          })),
      }),
    [setConfirmation, update],
  );
  const createEnvironmentLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["createEnvironment"]>
  >(
    () =>
      setEnvironmentDialog({
        id: crypto.randomUUID(),
        name: "New environment",
        variables: [],
      }),
    [setEnvironmentDialog],
  );
  const importRequestsLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["importRequests"]>
  >(() => setImporting(true), [setImporting]);
  const exportCollectionLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["exportCollection"]>
  >(
    (collection) =>
      downloadText(
        `${collection.name.replace(/[^a-z0-9_-]/gi, "-")}.json`,
        JSON.stringify(collection, null, 2),
      ),
    [],
  );
  const deleteSavedLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["deleteSaved"]>
  >(
    (collectionId, requestId) =>
      setConfirmation({
        title: "Remove saved request?",
        description: "The request will be removed from this collection.",
        action: () => update((current) => removeSavedRequest(current, collectionId, requestId)),
      }),
    [setConfirmation, update],
  );
  const deleteCollectionLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["deleteCollection"]>
  >(
    (id) =>
      setConfirmation({
        title: "Delete collection?",
        description:
          "Saved requests in this collection will be removed. Open request tabs will remain available.",
        action: () =>
          update((current) => ({
            ...current,
            collections: current.collections.filter((collection) => collection.id !== id),
          })),
      }),
    [setConfirmation, update],
  );
  const renameCollectionLibrary = useCallback<
    NonNullable<ComponentProps<typeof Library>["renameCollection"]>
  >(
    (id, name) =>
      update((current) => ({
        ...current,
        collections: current.collections.map((collection) =>
          collection.id === id
            ? {
                ...collection,
                name,
              }
            : collection,
        ),
      })),
    [update],
  );
  const closeLibrary = useCallback<NonNullable<ComponentProps<typeof Library>["close"]>>(
    () => setSideOpen(false),
    [setSideOpen],
  );
  const sendActiveRequest = useCallback<
    NonNullable<ComponentProps<typeof Action>["onClick"]>
  >(() => {
    setNotice(null);
    void run(active);
  }, [setNotice, run, active]);
  const cancelActiveRequest = useCallback<NonNullable<ComponentProps<typeof Action>["onClick"]>>(
    () => stop(active.id),
    [stop, active],
  );
  const onChangeRequestURL = useCallback<NonNullable<ComponentProps<"input">["onChange"]>>(
    (event) => change(withRequestUrl(active, event.target.value)),
    [change, active],
  );
  const onChangeHTTPMethod = useCallback<NonNullable<ComponentProps<"select">["onChange"]>>(
    (event) =>
      change({
        ...active,
        method: event.target.value as ApiRequest["method"],
      }),
    [change, active],
  );
  const changeCollapsed = useCallback(
    (collectionId: string, transform: (current: Set<string>) => Set<string>) => {
      update((current) => ({
        ...current,
        collapsedResources: {
          ...current.collapsedResources,
          [collectionId]: [...transform(new Set(current.collapsedResources?.[collectionId] ?? []))],
        },
      }));
    },
    [update],
  );
  const saveActiveRequest = useCallback<
    NonNullable<ComponentProps<typeof Action>["onClick"]>
  >(() => {
    const collection = state.collections.find((item) =>
      item.requests.some((request) => request.id === active.id),
    );
    if (!collection) {
      setSaving(active);
      return;
    }
    update((current) =>
      saveToCollection(current, active, collection.id, collection.locations?.[active.id]),
    );
    setNotice({ text: "Request saved", error: false });
  }, [state.collections, active, update, setNotice]);
  const onClickDismissNotice = useCallback<
    NonNullable<ComponentProps<typeof IconAction>["onClick"]>
  >(() => setNotice(null), [setNotice]);
  const onClickToggleAPIClientLibrary = useCallback<
    NonNullable<ComponentProps<typeof IconAction>["onClick"]>
  >(() => setSideOpen(!sideOpen), [setSideOpen, sideOpen]);
  const onChangeActiveEnvironment = useCallback(
    (id: string | null) => update((current) => ({ ...current, activeEnvironmentId: id })),
    [update],
  );
  const onChangeLibraryEnvironment = useCallback<
    NonNullable<ComponentProps<typeof Library>["environmentChange"]>
  >((event) => onChangeActiveEnvironment(event.target.value || null), [onChangeActiveEnvironment]);
  const handleShortcut = useCallback<NonNullable<ComponentProps<"div">["onKeyDown"]>>(
    (event) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void run(active);
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        saveActiveRequest();
      }
    },
    [run, active, saveActiveRequest],
  );
  const open = useCallback(
    (request: ApiRequest) => {
      update((current) => openRequest(current, request));
      if (compact) setSideOpen(false);
    },
    [update, compact, setSideOpen],
  );
  const fresh = useCallback(() => {
    open(newRequest());
    requestAnimationFrame(() => urlInput.current?.focus());
  }, [open]);
  const closeTabs = useCallback(
    (id: string, mode: CloseTabsMode) => {
      const requests = tabsToClose(state, id, mode);
      if (!requests.length) return;
      const ids = requests.map((request) => request.id);
      const action = () => {
        for (const requestId of ids) forget(requestId);
        update((current) => closeRequests(current, ids));
      };
      const modified = requests.filter((request) => needsDiscardConfirmation(state, request));
      if (modified.length)
        setConfirmation({
          title: requests.length === 1 ? "Close request?" : "Close requests?",
          description:
            requests.length === 1
              ? "This request has changes that have not been saved to a collection."
              : `${modified.length} request${modified.length === 1 ? " has" : "s have"} unsaved changes. Discard changes and close the selected tabs?`,
          action,
        });
      else action();
    },
    [forget, update, state, setConfirmation],
  );
  const close = useCallback((request: ApiRequest) => closeTabs(request.id, "current"), [closeTabs]);
  const save = useCallback(
    (name: string, collectionId: string, folderId?: string) => {
      if (!saving) return;
      const request = {
        ...saving,
        name,
      };
      update((current) => saveToCollection(current, request, collectionId, folderId));
      setNotice({
        text: "Request saved",
        error: false,
      });
    },
    [saving, update, setNotice],
  );
  const history = useCallback(
    (entry: HistoryEntry) => {
      update((current) => openHistoryRequest(current, entry));
      if (compact) setSideOpen(false);
    },
    [update, compact, setSideOpen],
  );
  const copyCurl = useCallback(() => {
    void copyText(toCurl(active))
      .then(() =>
        setNotice({
          text: "cURL copied",
          error: false,
        }),
      )
      .catch((cause: unknown) =>
        error(cause instanceof Error ? cause.message : "Unable to copy cURL."),
      );
  }, [active, setNotice, error]);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const createCollection = useCallback(() => setCreatingCollection(true), []);
  const closeCollectionDialog = useCallback(() => setCreatingCollection(false), []);
  const saveNewCollection = useCallback(
    (name: string) => {
      update((current) => ({
        ...current,
        collections: [
          ...current.collections,
          {
            id: crypto.randomUUID(),
            name,
            requests: [],
          },
        ],
      }));
      setSideOpen(true);
      setCreatingCollection(false);
    },
    [update, setSideOpen],
  );
  const moveResource = useCallback(
    (sourceId: string, target: TreeTarget, destinationId: string, folderId: string) => {
      update((current) =>
        moveCollectionResource(current, sourceId, target, destinationId, folderId),
      );
    },
    [update],
  );
  const changeCollection = useCallback(
    (collection: Collection) => {
      const validated = collectionSchema.parse(collection);
      update((current) => replaceCollection(current, validated));
    },
    [update],
  );
  const duplicateCollection = useCallback(
    (collection: Collection) =>
      update((current) => ({
        ...current,
        collections: [...current.collections, cloneCollection(collection)],
      })),
    [update],
  );
  return (
    <VariableProvider
      state={state}
      theme={theme}
      update={update}
      rootRef={root}
      compact={compact}
      rootStyle={styles}
      onKeyDown={handleShortcut}
    >
      <style>{css}</style>
      <Notice storageError={storageError} notice={notice} dismiss={onClickDismissNotice} />
      <WorkspaceLayout testID="api-client-workspace">
        <WorkspaceIsland testID="api-client-main-island">
          <main className="ac-main" data-editing-environment={Boolean(environmentDialog)}>
            <div className="ac-request-tabs" role="tablist" aria-label="API request tabs">
              <div className="ac-tabs-scroll">
                {state.tabs.map((request) => (
                  <RequestTab
                    key={request.id}
                    request={request}
                    active={request.id === active.id}
                    modified={isModified(state, request)}
                    open={open}
                    close={close}
                    closeTabs={closeTabs}
                    tabIds={tabIds}
                  />
                ))}
              </div>
              <div className="ac-tabs-actions">
                <IconAction icon="Plus" label="New API request" onClick={fresh} />
                {!sideOpen && (
                  <IconAction
                    icon="PanelRight"
                    label="Toggle API Client library"
                    onClick={onClickToggleAPIClientLibrary}
                  />
                )}
              </div>
            </div>
            <div className="ac-request-heading">
              <div className="ac-request-identity">
                <span className="ac-muted">{collectionName}</span>
                <span className="ac-heading-divider">/</span>
                <span>{active.name}</span>
              </div>
              <div className="ac-inline">
                <IconAction icon="Copy" label="Copy as cURL" onClick={copyCurl} />
                <EnvironmentPicker
                  environments={state.environments}
                  activeId={state.activeEnvironmentId}
                  onChange={onChangeActiveEnvironment}
                  onCreate={createEnvironmentLibrary}
                />
                <Action icon="Save" onClick={saveActiveRequest}>
                  Save
                </Action>
                <IconAction
                  icon={columns ? "Rows2" : "Columns2"}
                  label={
                    columns
                      ? "Stack request and response"
                      : "Show request and response side by side"
                  }
                  onClick={toggleLayout}
                />
              </div>
            </div>
            <div className="ac-request-bar">
              <div className="ac-url-frame">
                <MethodSelect method={active.method} onChange={onChangeHTTPMethod} />
                <VariableInput
                  inputRef={urlInput}
                  aria-label="Request URL"
                  placeholder="https://api.example.com or {{baseUrl}}/path"
                  value={active.url}
                  onChange={onChangeRequestURL}
                  spellCheck={false}
                />
              </div>
              <div className="ac-request-actions">
                {result?.pending ? (
                  <Action className="ac-send" size="sm" icon="Square" onClick={cancelActiveRequest}>
                    Cancel
                  </Action>
                ) : (
                  <Action
                    primary
                    className="ac-send"
                    size="sm"
                    icon="ArrowRight"
                    disabled={!active.url.trim()}
                    onClick={sendActiveRequest}
                  >
                    Send
                  </Action>
                )}
              </div>
            </div>
            {environmentDialog ? (
              <>
                {" "}
                {environmentDialog && (
                  <EnvironmentDialog
                    key={
                      typeof environmentDialog === "string"
                        ? environmentDialog
                        : environmentDialog.id
                    }
                    inline
                    theme={theme}
                    close={closeEnvironmentDialog}
                    environment={environmentDialog === "globals" ? undefined : environmentDialog}
                    globals={environmentDialog === "globals" ? state.globals : undefined}
                    onSave={onSaveEnvironmentDialog}
                  />
                )}{" "}
              </>
            ) : (
              <RequestWorkspace
                request={active}
                result={result}
                onChange={change}
                onError={error}
                columns={columns && !compact}
              />
            )}
          </main>
        </WorkspaceIsland>
        <WorkspaceSidebar
          open={sideOpen}
          onOpenChange={setSideOpen}
          compact={compact}
          persistenceKey={`api-client:${host.id}`}
          testID="api-client-library-island"
        >
          <Library
            changeCollapsed={changeCollapsed}
            theme={theme}
            moveResource={moveResource}
            changeCollection={changeCollection}
            duplicateCollection={duplicateCollection}
            state={state}
            environmentChange={onChangeLibraryEnvironment}
            close={closeLibrary}
            open={open}
            openHistory={history}
            createCollection={createCollection}
            renameCollection={renameCollectionLibrary}
            deleteCollection={deleteCollectionLibrary}
            deleteSaved={deleteSavedLibrary}
            exportCollection={exportCollectionLibrary}
            importRequests={importRequestsLibrary}
            createEnvironment={createEnvironmentLibrary}
            editEnvironment={setEnvironmentDialog}
            deleteEnvironment={deleteEnvironmentLibrary}
            editGlobals={editGlobalsLibrary}
            clearHistory={clearHistoryLibrary}
            clearCookies={clearCookiesLibrary}
          />
        </WorkspaceSidebar>
      </WorkspaceLayout>
      {creatingCollection && (
        <NameDialog
          theme={theme}
          title="New collection"
          label="Collection name"
          close={closeCollectionDialog}
          submit={saveNewCollection}
        />
      )}
      {importing && (
        <ImportDialog theme={theme} close={closeImportDialog} onImport={onImportImportDialog} />
      )}
      {saving && (
        <SaveDialog
          theme={theme}
          close={closeSaveDialog}
          collections={state.collections}
          requestName={saving.name}
          initialCollectionId={requestCollection(state, saving.id)?.id}
          initialFolderId={savedCollection?.locations?.[saving.id]}
          onSave={save}
        />
      )}
    </VariableProvider>
  );
}

function RequestTab({
  request,
  active,
  modified,
  open,
  close,
  closeTabs,
  tabIds,
}: {
  closeTabs: (id: string, mode: CloseTabsMode) => void;
  tabIds: readonly string[];
  request: ApiRequest;
  active: boolean;
  modified: boolean;
  open: (request: ApiRequest) => void;
  close: (request: ApiRequest) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) element.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const select = useCallback(() => open(request), [open, request]);
  const dismiss = useCallback(() => close(request), [close, request]);
  const prepareMenu = useCallback(() => {}, []);
  const selectAction = useCallback(
    (mode: string) => closeTabs(request.id, mode as CloseTabsMode),
    [closeTabs, request.id],
  );
  const actions = useMemo(() => {
    const index = tabIds.indexOf(request.id);
    return [
      { id: "current", label: "Close" },
      { id: "left", label: "Close to the left", disabled: index === 0, separatorBefore: true },
      { id: "right", label: "Close to the right", disabled: index === tabIds.length - 1 },
      { id: "others", label: "Close other tabs", disabled: tabIds.length < 2 },
      { id: "all", label: "Close all tabs" },
    ];
  }, [tabIds, request.id]);
  return (
    <ContextMenu actions={actions} onOpen={prepareMenu} onSelect={selectAction}>
      <div ref={element} className="ac-request-tab" data-active={active}>
        <button
          type="button"
          role="tab"
          aria-selected={active}
          title={request.url || request.name}
          onClick={select}
        >
          <span className="ac-method" data-method={request.method}>
            {request.method}
          </span>
          <span className="ac-truncate">{request.name || "Untitled request"}</span>
          {modified && <span className="ac-dirty-dot" aria-label="Unsaved request" />}
        </button>
        <IconAction icon="X" label={`Close ${request.name}`} onClick={dismiss} />
      </div>
    </ContextMenu>
  );
}

function Notice({
  storageError,
  notice,
  dismiss,
}: {
  storageError: string | null;
  notice: { text: string; error: boolean } | null;
  dismiss: ComponentProps<typeof IconAction>["onClick"];
}) {
  if (!storageError && !notice) return null;
  return (
    <div
      className="ac-notice"
      role={storageError || notice?.error ? "alert" : "status"}
      data-error={Boolean(storageError || notice?.error)}
    >
      <span className="ac-truncate">{storageError || notice?.text}</span>
      {!storageError && <IconAction icon="X" label="Dismiss notice" onClick={dismiss} />}
    </div>
  );
}

function MethodSelect({
  method,
  onChange,
}: {
  method: ApiRequest["method"];
  onChange: ComponentProps<"select">["onChange"];
}) {
  return (
    <div className="ac-method-control">
      <select
        aria-label="HTTP method"
        className="ac-method-select"
        data-method={method}
        value={method}
        onChange={onChange}
      >
        {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((value) => (
          <option key={value} data-method={value}>
            {value}
          </option>
        ))}
      </select>
      <span className="ac-method-chevron" aria-hidden="true">
        <Icon name="ChevronDown" size={14} color="currentColor" />
      </span>
    </div>
  );
}
