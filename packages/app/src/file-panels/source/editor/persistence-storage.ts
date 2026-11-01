import { z } from "zod";
import {
  draftRecordSchema,
  editorViewStateSchema,
  editorPersistenceId,
  type EditorStorage,
  type EditorViewState,
} from "./persistence";

let opening: Promise<IDBDatabase> | null = null;
let owner: string | null = null;
function ownerId(): string {
  owner ??= editorPersistenceId();
  return owner;
}
const OWNER_LOCK_PREFIX = "mixer-editor-owner:";
let ownership: Promise<void> | null = null;

function acquireOwnership(): Promise<void> {
  if (!navigator.locks) return Promise.resolve();
  if (ownership) return ownership;
  const task = new Promise<void>((resolve, reject) => {
    // The browser releases this lock when the page crashes or closes. Live windows' backups
    // must not be offered for recovery or cleared by a sibling window.
    void navigator.locks
      .request(OWNER_LOCK_PREFIX + ownerId(), async () => {
        resolve();
        await new Promise<void>(() => {});
      })
      .catch(reject);
  });
  ownership = task;
  void task.catch(() => {
    if (ownership === task) ownership = null;
  });
  return task;
}

async function activeOwners(): Promise<Set<string>> {
  if (!navigator.locks) return new Set();
  const locks = await navigator.locks.query();
  const names = (locks.held ?? []).map((lock) => lock.name ?? "");
  return new Set(
    names
      .filter((name) => name.startsWith(OWNER_LOCK_PREFIX))
      .map((name) => name.slice(OWNER_LOCK_PREFIX.length)),
  );
}
function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  const task = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Local draft storage is unavailable"));
      return;
    }
    const request = indexedDB.open("mixer-editor", 1);
    let failed = false;
    request.addEventListener("upgradeneeded", () => {
      const drafts = request.result.createObjectStore("drafts", { keyPath: "id" });
      drafts.createIndex("fileKey", "fileKey");
      request.result.createObjectStore("views");
    });
    request.addEventListener("error", () => {
      failed = true;
      reject(request.error ?? new Error("Cannot open local editor storage"));
    });
    request.addEventListener("blocked", () => {
      failed = true;
      reject(new Error("Another window is blocking local editor storage"));
    });
    request.addEventListener("success", () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.addEventListener("versionchange", () => {
        db.close();
        opening = null;
      });
      resolve(db);
    });
  });
  opening = task;
  void task.catch(() => {
    if (opening === task) opening = null;
  });
  return task;
}

async function transaction<T>(
  name: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    let value: T;
    tx.addEventListener("complete", () => resolve(value));
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("Editor storage transaction aborted")),
    );
    tx.addEventListener("error", () =>
      reject(tx.error ?? new Error("Editor storage transaction failed")),
    );
    try {
      work(tx.objectStore(name), (next) => {
        value = next;
      });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

const storage: EditorStorage = {
  async drafts(fileKey) {
    await acquireOwnership();
    const records = await transaction<unknown[]>("drafts", "readonly", (store, result) => {
      const request: IDBRequest<unknown[]> = store.index("fileKey").getAll(fileKey);
      request.onsuccess = () => result(request.result);
    });
    const active = await activeOwners();
    return z
      .array(draftRecordSchema)
      .parse(records)
      .filter((record) => !record.owner || record.owner === ownerId() || !active.has(record.owner));
  },
  async writeDraft(record) {
    const validated = draftRecordSchema.parse(record);
    await acquireOwnership();
    return transaction<void>("drafts", "readwrite", (store, result) => {
      store.put({ ...validated, owner: ownerId() });
      result(undefined);
    });
  },
  async clearDraft(id, restored) {
    const active = await activeOwners();
    const mayClearRestored =
      restored && (!restored.owner || restored.owner === ownerId() || !active.has(restored.owner));
    return transaction<void>("drafts", "readwrite", (store, result) => {
      store.delete(id);
      if (restored && mayClearRestored && restored.id !== id) {
        const request: IDBRequest<unknown> = store.get(restored.id);
        request.onsuccess = () => {
          const current = draftRecordSchema.safeParse(request.result);
          if (
            current.success &&
            current.data.fileKey === restored.fileKey &&
            current.data.lineSeparator === restored.lineSeparator &&
            current.data.updatedAt === restored.updatedAt &&
            current.data.content === restored.content &&
            current.data.base === restored.base
          )
            store.delete(restored.id);
        };
      }
      result(undefined);
    });
  },
  readView(key) {
    return transaction<EditorViewState | null>("views", "readonly", (store, result) => {
      const request: IDBRequest<unknown> = store.get(key);
      request.onsuccess = () => {
        const parsed = editorViewStateSchema.safeParse(request.result);
        result(parsed.success ? parsed.data : null);
      };
    });
  },
  writeView(key, state) {
    return transaction<void>("views", "readwrite", (store, result) => {
      store.put(state, key);
      result(undefined);
    });
  },
};
export function editorStorage(): EditorStorage {
  return storage;
}
