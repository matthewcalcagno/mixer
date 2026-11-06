import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { ActionMenu, ContextMenu, Icon, confirmDialog } from "@mixer/plugin/client/ui";
import type { PluginTheme } from "@mixer/plugin";
import type { ApiRequest } from "../shared/contracts.js";
import { newRequest } from "../shared/request.js";
import type { Collection } from "./model.js";
import {
  descendantIds,
  deleteTree,
  duplicateTree,
  folderPath,
  moveTree,
  renameTree,
  treeName,
  type TreeTarget,
} from "./collection-model.js";
import { Dialog, NameDialog, EnvironmentDialog } from "./dialogs.js";
import { Action, Field, IconAction } from "./controls.js";
const noop = () => {};
interface ResourceDrag {
  collectionId: string;
  target: TreeTarget;
  descendants: Set<string>;
}
let resourceDrag: ResourceDrag | null = null;
interface TreeProps {
  moveResource: (
    sourceId: string,
    target: TreeTarget,
    destinationId: string,
    folderId: string,
  ) => void;
  collapsedIds?: string[];
  changeCollapsed: (collectionId: string, change: (current: Set<string>) => Set<string>) => void;
  collection: Collection;
  query: string;
  activeId: string;
  theme: PluginTheme;
  open: (request: ApiRequest) => void;
  change: (collection: Collection) => void;
  duplicate: (collection: Collection) => void;
  remove: (id: string) => void;
  exportCollection: (collection: Collection) => void;
}
export function CollectionTree(props: TreeProps) {
  const {
    collection,
    change,
    open,
    remove,
    duplicate,
    exportCollection,
    moveResource,
    changeCollapsed,
  } = props;
  const [editingVariables, setEditingVariables] = useState(false);
  const closeVariables = useCallback(() => setEditingVariables(false), []);
  const saveVariables = useCallback(
    (environment: import("../shared/contracts.js").Environment) =>
      change({ ...collection, variables: environment.variables }),
    [change, collection],
  );
  const collectionEnvironment = useMemo(
    () => ({ id: collection.id, name: collection.name, variables: collection.variables ?? [] }),
    [collection],
  );
  const collapsed = useMemo(() => new Set(props.collapsedIds ?? []), [props.collapsedIds]);
  const setCollapsed = useCallback(
    (next: Set<string> | ((current: Set<string>) => Set<string>)) =>
      changeCollapsed(collection.id, (current) =>
        typeof next === "function" ? next(current) : next,
      ),
    [changeCollapsed, collection.id],
  );
  const [dialog, setDialog] = useState<{
    mode: "rename" | "move" | "create-folder";
    target: TreeTarget;
    name: string;
  } | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const commit = useCallback(
    (value: string) => {
      if (!dialog) return;
      if (dialog.mode === "create-folder") {
        const parentId = dialog.target.kind === "folder" ? dialog.target.id : null;
        change({
          ...collection,
          folders: [
            ...(collection.folders ?? []),
            { id: crypto.randomUUID(), name: value.trim(), parentId },
          ],
        });
        setCollapsed(new Set());
      } else {
        change(
          dialog.mode === "rename"
            ? renameTree(collection, dialog.target, value.trim())
            : moveTree(collection, dialog.target, value),
        );
      }
      setDialog(null);
    },
    [collection, change, dialog, setCollapsed],
  );
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [setCollapsed],
  );
  const action = useCallback(
    (target: TreeTarget, id: string) => {
      const parent = target.kind === "folder" ? target.id : null;
      if (id === "add-folder") {
        setDialog({ mode: "create-folder", target, name: "" });
      } else if (id === "add-request") {
        const request = newRequest();
        change({
          ...collection,
          requests: [...collection.requests, request],
          locations: { ...collection.locations, ...(parent ? { [request.id]: parent } : {}) },
        });
        setCollapsed(new Set());
        open(request);
      } else if (id === "rename" || id === "move") {
        const name = treeName(collection, target);
        setDialog({ mode: id, target, name: name ?? "" });
      } else if (id === "duplicate") {
        if (target.kind === "collection") duplicate(collection);
        else change(duplicateTree(collection, target));
      } else if (id === "sort")
        change({ ...collection, sort: collection.sort === "name" ? "default" : "name" });
      else if (id === "variables") setEditingVariables(true);
      else if (id === "export") exportCollection(collection);
      else if (id === "delete") {
        if (target.kind === "collection") {
          remove(collection.id);
          return;
        }
        void confirmDialog({
          title: `Delete ${target.kind}?`,
          message:
            target.kind === "request"
              ? "The saved request will be removed. Open tabs stay available."
              : "This removes its saved requests and folders. Open tabs stay available.",
          confirmLabel: "Delete",
          destructive: true,
        }).then((confirmed) => {
          if (confirmed) {
            change(deleteTree(collection, target));
          }
          return undefined;
        });
      }
    },
    [change, collection, duplicate, exportCollection, open, remove, setCollapsed],
  );
  const beginDrag = useCallback(
    (target: TreeTarget) => {
      resourceDrag = {
        collectionId: collection.id,
        target,
        descendants: target.kind === "folder" ? descendantIds(collection, target.id) : new Set(),
      };
    },
    [collection],
  );
  const dropResource = useCallback(
    (source: ResourceDrag, destination: TreeTarget) => {
      const folderId = destination.kind === "folder" ? destination.id : "";
      moveResource(source.collectionId, source.target, collection.id, folderId);
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(destination.id);
        return next;
      });
    },
    [collection.id, moveResource, setCollapsed],
  );
  const rows = useMemo(() => {
    const result: { target: TreeTarget; name: string; depth: number; request?: ApiRequest }[] = [];
    const sorted = <T extends { name: string }>(items: T[]) =>
      collection.sort === "name" ? items.toSorted((a, b) => a.name.localeCompare(b.name)) : items;
    const query = props.query.toLowerCase();
    const includeAll = collection.name.toLowerCase().includes(query);
    const matchingFolders = new Set<string>();
    const includeAncestors = (id: string | undefined) => {
      const seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        matchingFolders.add(id);
        id = collection.folders?.find((folder) => folder.id === id)?.parentId ?? undefined;
      }
    };
    for (const folder of collection.folders ?? [])
      if (includeAll || folder.name.toLowerCase().includes(query)) includeAncestors(folder.id);
    for (const request of collection.requests)
      if (includeAll || `${request.name} ${request.url}`.toLowerCase().includes(query))
        includeAncestors(collection.locations?.[request.id]);
    const walk = (
      parentId: string | null,
      depth: number,
      inheritedMatch: boolean,
      visited: Set<string>,
    ) => {
      for (const folder of sorted(
        (collection.folders ?? []).filter((item) => item.parentId === parentId),
      )) {
        if (visited.has(folder.id)) continue;
        const match = inheritedMatch || folder.name.toLowerCase().includes(query);
        if (!match && !matchingFolders.has(folder.id)) continue;
        result.push({ target: { kind: "folder", id: folder.id }, name: folder.name, depth });
        if (query || !collapsed.has(folder.id))
          walk(folder.id, depth + 1, match, new Set([...visited, folder.id]));
      }
      for (const request of sorted(
        collection.requests.filter(
          (item) => (collection.locations?.[item.id] ?? null) === parentId,
        ),
      )) {
        if (inheritedMatch || `${request.name} ${request.url}`.toLowerCase().includes(query))
          result.push({
            target: { kind: "request", id: request.id },
            name: request.name,
            depth,
            request,
          });
      }
    };
    walk(null, 1, includeAll, new Set());
    if (!includeAll && !result.length) return [];
    return [
      {
        target: { kind: "collection" as const, id: collection.id },
        name: collection.name,
        depth: 0,
      },
      ...(!collapsed.has(collection.id) || query ? result : []),
    ];
  }, [collection, props.query, collapsed]);
  return (
    <section className="ac-collection-tree">
      {editingVariables && (
        <EnvironmentDialog
          theme={props.theme}
          scopeName={collection.name}
          environment={collectionEnvironment}
          close={closeVariables}
          onSave={saveVariables}
        />
      )}
      {rows.map((row) => (
        <TreeRow
          key={row.target.id}
          {...row}
          active={row.target.id === props.activeId}
          collapsed={collapsed.has(row.target.id)}
          action={action}
          toggle={toggle}
          open={open}
          beginDrag={beginDrag}
          dropResource={dropResource}
          collectionId={collection.id}
          sorted={collection.sort === "name"}
        />
      ))}
      {dialog && (
        <TreeDialog
          key={`${dialog.mode}:${dialog.target.id}`}
          theme={props.theme}
          mode={dialog.mode}
          name={dialog.name}
          target={dialog.target}
          collection={collection}
          close={closeDialog}
          submit={commit}
        />
      )}
    </section>
  );
}
interface RowProps {
  collectionId: string;
  beginDrag(target: TreeTarget): void;
  dropResource(source: ResourceDrag, destination: TreeTarget): void;
  target: TreeTarget;
  name: string;
  depth: number;
  request?: ApiRequest;
  active: boolean;
  collapsed: boolean;
  sorted: boolean;
  toggle(id: string): void;
  open(request: ApiRequest): void;
  action(target: TreeTarget, id: string): void;
}
function TreeRow(props: RowProps) {
  const {
    target,
    name,
    request,
    action,
    toggle,
    open,
    collectionId,
    beginDrag: beginResourceDrag,
    dropResource: dropIntoRow,
  } = props;
  const [dropActive, setDropActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const canDrop = useCallback(
    () =>
      Boolean(
        resourceDrag &&
        target.kind !== "request" &&
        !(resourceDrag.collectionId === collectionId && resourceDrag.descendants.has(target.id)),
      ),
    [collectionId, target],
  );
  const dragStart = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (target.kind === "collection") return;
      beginResourceDrag(target);
      event.dataTransfer.setData(
        "application/x-mixer-api-resource",
        JSON.stringify({ collectionId: collectionId, target }),
      );
      event.dataTransfer.effectAllowed = "move";
      event.stopPropagation();
      setDragging(true);
    },
    [beginResourceDrag, collectionId, target],
  );
  const dragEnd = useCallback(() => {
    resourceDrag = null;
    setDragging(false);
    setDropActive(false);
  }, []);
  const dragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDrop()) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropActive(true);
    },
    [canDrop],
  );
  const dragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    setDropActive(false);
  }, []);
  const drop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canDrop() || !resourceDrag) return;
      event.preventDefault();
      event.stopPropagation();
      dropIntoRow(resourceDrag, target);
      resourceDrag = null;
      setDropActive(false);
    },
    [canDrop, dropIntoRow, target],
  );

  const select = useCallback(
    () => (request ? open(request) : toggle(target.id)),
    [request, open, toggle, target.id],
  );
  const onAction = useCallback((id: string) => action(target, id), [action, target]);
  const addRequest = useCallback(() => action(target, "add-request"), [action, target]);
  const actions = useMemo(
    () => [
      ...(!request
        ? [
            { id: "add-request", label: "Add request" },
            { id: "add-folder", label: "Add folder" },
          ]
        : []),
      { id: "rename", label: "Rename", separatorBefore: !request },
      { id: "duplicate", label: "Duplicate" },
      ...(target.kind !== "collection" ? [{ id: "move", label: "Move…" }] : []),
      ...(!request
        ? [{ id: "sort", label: props.sorted ? "Sort: default order" : "Sort: A to Z" }]
        : []),
      ...(target.kind === "collection"
        ? [
            { id: "variables", label: "Variables" },
            { id: "export", label: "Export collection" },
          ]
        : []),
      { id: "delete", label: "Delete", separatorBefore: true },
    ],
    [request, target.kind, props.sorted],
  );
  const style = useMemo(() => ({ "--ac-tree-depth": props.depth }) as CSSProperties, [props.depth]);
  return (
    <ContextMenu actions={actions} onOpen={noop} onSelect={onAction}>
      <div
        className="ac-tree-row"
        data-resource-id={target.id}
        data-active={props.active}
        data-kind={target.kind}
        style={style}
        draggable={target.kind !== "collection"}
        onDragStart={dragStart}
        onDragEnd={dragEnd}
        onDragOver={dragOver}
        onDragLeave={dragLeave}
        onDrop={drop}
        data-drop={dropActive}
        data-dragging={dragging}
      >
        <button
          type="button"
          onClick={select}
          title={request?.url ?? name}
          aria-expanded={request ? undefined : !props.collapsed}
        >
          {!request && (
            <Icon
              name={props.collapsed ? "ChevronRight" : "ChevronDown"}
              size={12}
              color="currentColor"
            />
          )}
          {!request && (
            <Icon
              name={target.kind === "collection" ? "Layers" : "Folder"}
              size={14}
              color="currentColor"
            />
          )}
          {request && <span className="ac-tree-toggle-spacer" aria-hidden="true" />}
          {request && (
            <span className="ac-method" data-method={request.method}>
              {request.method}
            </span>
          )}
          <span className="ac-truncate">{name}</span>
        </button>
        <div className="ac-tree-actions">
          {!request && (
            <IconAction icon="Plus" label={`Add request to ${name}`} onClick={addRequest} />
          )}
          <ActionMenu label={`Actions for ${name}`} actions={actions} onSelect={onAction} />
        </div>
      </div>
    </ContextMenu>
  );
}
function TreeDialog({
  theme,
  mode,
  name,
  target,
  collection,
  close,
  submit,
}: {
  theme: PluginTheme;
  mode: "rename" | "move" | "create-folder";
  name: string;
  target: TreeTarget;
  collection: Collection;
  close(): void;
  submit(value: string): void;
}) {
  const [value, setValue] = useState(mode === "rename" ? name : "");
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValue(event.target.value),
    [],
  );
  const save = useCallback(() => submit(value), [submit, value]);
  const excluded =
    target.kind === "folder" ? descendantIds(collection, target.id) : new Set<string>();
  if (mode !== "move")
    return (
      <NameDialog
        theme={theme}
        title={mode === "create-folder" ? "New folder" : `Rename ${target.kind}`}
        label={mode === "create-folder" ? "Folder name" : "Name"}
        initialName={name}
        confirmLabel={mode === "create-folder" ? "Create" : "Rename"}
        close={close}
        submit={submit}
      />
    );
  return (
    <Dialog theme={theme} title={`Move ${name}`} close={close}>
      <Field label="Destination">
        <select aria-label="Destination folder" value={value} onChange={change}>
          <option value="">{collection.name} (root)</option>
          {collection.folders
            ?.filter((folder) => !excluded.has(folder.id))
            .map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folderPath(collection, folder.id)}
              </option>
            ))}
        </select>
      </Field>
      <div className="ac-dialog-actions">
        <Action onClick={close}>Cancel</Action>
        <Action primary onClick={save}>
          Move
        </Action>
      </div>
    </Dialog>
  );
}
