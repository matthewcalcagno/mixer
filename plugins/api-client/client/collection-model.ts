import type { Collection } from "./model.js";
export type Folder = NonNullable<Collection["folders"]>[number];
export interface TreeTarget {
  kind: "collection" | "folder" | "request";
  id: string;
}
export function folderPath(collection: Collection, id: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let folder = collection.folders?.find((item) => item.id === id);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    parts.unshift(folder.name);
    folder = collection.folders?.find((item) => item.id === folder!.parentId);
  }
  return parts.join(" / ");
}
export function descendantIds(collection: Collection, id: string): Set<string> {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const folder of collection.folders ?? []) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}
export function cloneCollection(collection: Collection): Collection {
  const folders = new Map(
    (collection.folders ?? []).map((folder) => [folder.id, crypto.randomUUID()]),
  );
  const requests = new Map(collection.requests.map((request) => [request.id, crypto.randomUUID()]));
  return {
    ...structuredClone(collection),
    id: crypto.randomUUID(),
    name: `${collection.name} copy`,
    folders: collection.folders?.map((folder) => ({
      ...folder,
      id: folders.get(folder.id)!,
      parentId: folder.parentId ? (folders.get(folder.parentId) ?? null) : null,
    })),
    requests: collection.requests.map((request) => ({
      ...structuredClone(request),
      id: requests.get(request.id)!,
    })),
    locations: Object.fromEntries(
      Object.entries(collection.locations ?? []).flatMap(([id, folder]) =>
        requests.has(id) && folders.has(folder) ? [[requests.get(id)!, folders.get(folder)!]] : [],
      ),
    ),
  };
}
export function renameTree(collection: Collection, target: TreeTarget, name: string): Collection {
  return {
    ...collection,
    name: target.kind === "collection" ? name : collection.name,
    folders: collection.folders?.map((folder) =>
      folder.id === target.id && target.kind === "folder" ? { ...folder, name } : folder,
    ),
    requests: collection.requests.map((request) =>
      request.id === target.id && target.kind === "request" ? { ...request, name } : request,
    ),
  };
}
export function deleteTree(collection: Collection, target: TreeTarget): Collection {
  const removed =
    target.kind === "folder" ? descendantIds(collection, target.id) : new Set<string>();
  const requests = collection.requests.filter((request) =>
    target.kind === "request"
      ? request.id !== target.id
      : !removed.has(collection.locations?.[request.id] ?? ""),
  );
  const retained = new Set(requests.map((request) => request.id));
  return {
    ...collection,
    requests,
    folders: collection.folders?.filter((folder) => !removed.has(folder.id)),
    locations: Object.fromEntries(
      Object.entries(collection.locations ?? []).filter(([id]) => retained.has(id)),
    ),
  };
}
export function moveTree(collection: Collection, target: TreeTarget, folderId: string): Collection {
  if (target.kind === "folder") {
    if (descendantIds(collection, target.id).has(folderId))
      throw new Error("A folder cannot move inside itself.");
    return {
      ...collection,
      folders: collection.folders?.map((folder) =>
        folder.id === target.id
          ? { id: folder.id, name: folder.name, parentId: folderId || null }
          : folder,
      ),
    };
  }
  const locations = { ...collection.locations };
  if (folderId) locations[target.id] = folderId;
  else delete locations[target.id];
  return { ...collection, locations };
}
export function duplicateTree(collection: Collection, target: TreeTarget): Collection {
  if (target.kind === "request") {
    const request = collection.requests.find((item) => item.id === target.id)!;
    const id = crypto.randomUUID();
    return {
      ...collection,
      requests: [
        ...collection.requests,
        { ...structuredClone(request), id, name: `${request.name} copy` },
      ],
      locations: {
        ...collection.locations,
        ...(collection.locations?.[target.id] ? { [id]: collection.locations[target.id] } : {}),
      },
    };
  }
  const ids = descendantIds(collection, target.id);
  const copy = cloneCollection({
    ...collection,
    folders: collection.folders?.filter((folder) => ids.has(folder.id)),
    requests: collection.requests.filter((request) =>
      ids.has(collection.locations?.[request.id] ?? ""),
    ),
  });
  const original = collection.folders?.find((folder) => folder.id === target.id);
  const folders = copy.folders?.map((folder) =>
    folder.parentId
      ? folder
      : { ...folder, name: `${folder.name} copy`, parentId: original?.parentId ?? null },
  );
  return {
    ...collection,
    folders: [...(collection.folders ?? []), ...(folders ?? [])],
    requests: [...collection.requests, ...copy.requests],
    locations: { ...collection.locations, ...copy.locations },
  };
}

export function treeName(collection: Collection, target: TreeTarget): string {
  if (target.kind === "collection") return collection.name;
  if (target.kind === "folder")
    return collection.folders?.find((folder) => folder.id === target.id)?.name ?? "";
  return collection.requests.find((request) => request.id === target.id)?.name ?? "";
}
export function replaceCollection(
  state: import("./model.js").ClientState,
  collection: Collection,
): import("./model.js").ClientState {
  const before = new Map(
    state.collections
      .find((item) => item.id === collection.id)
      ?.requests.map((request) => [request.id, request.name]),
  );
  const after = new Map(collection.requests.map((request) => [request.id, request.name]));
  return {
    ...state,
    collections: state.collections.map((item) => (item.id === collection.id ? collection : item)),
    tabs: state.tabs.map((tab) =>
      before.has(tab.id) && after.has(tab.id) && before.get(tab.id) !== after.get(tab.id)
        ? { ...tab, name: after.get(tab.id)! }
        : tab,
    ),
  };
}

export function collectionBreadcrumb(
  collection: Collection | undefined,
  requestId: string,
): string {
  if (!collection) return "Unsaved request";
  const folderId = collection.locations?.[requestId];
  return [collection.name, folderId ? folderPath(collection, folderId) : ""]
    .filter(Boolean)
    .join(" / ");
}

export function moveCollectionResource(
  state: import("./model.js").ClientState,
  sourceId: string,
  target: TreeTarget,
  destinationId: string,
  folderId: string,
): import("./model.js").ClientState {
  const source = state.collections.find((collection) => collection.id === sourceId);
  const destination = state.collections.find((collection) => collection.id === destinationId);
  if (!source || !destination || target.kind === "collection")
    throw new Error("Choose a request or folder to move.");
  if (folderId && !destination.folders?.some((folder) => folder.id === folderId))
    throw new Error("The destination folder no longer exists.");
  const exists =
    target.kind === "folder"
      ? source.folders?.some((folder) => folder.id === target.id)
      : source.requests.some((request) => request.id === target.id);
  if (!exists) throw new Error("This item no longer exists.");
  if (sourceId === destinationId)
    return replaceCollection(state, moveTree(source, target, folderId));
  const folders = target.kind === "folder" ? descendantIds(source, target.id) : new Set<string>();
  const requests = source.requests.filter((request) =>
    target.kind === "request"
      ? request.id === target.id
      : folders.has(source.locations?.[request.id] ?? ""),
  );
  const locations = { ...destination.locations };
  for (const request of requests) {
    const parent = target.kind === "request" ? folderId : source.locations?.[request.id];
    if (parent) locations[request.id] = parent;
  }
  const moved: Collection = {
    ...destination,
    requests: [...destination.requests, ...requests],
    locations,
    folders: [
      ...(destination.folders ?? []),
      ...(source.folders
        ?.filter((folder) => folders.has(folder.id))
        .map((folder) =>
          folder.id === target.id
            ? { id: folder.id, name: folder.name, parentId: folderId || null }
            : folder,
        ) ?? []),
    ],
  };
  const removed = deleteTree(source, target);
  return {
    ...state,
    collections: state.collections.map((collection) => {
      if (collection.id === sourceId) return removed;
      return collection.id === destinationId ? moved : collection;
    }),
  };
}
