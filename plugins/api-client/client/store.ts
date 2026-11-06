import { useEffect, useState, useSyncExternalStore } from "react";
import { initialState, stateSchema, type ClientState } from "./model.js";

class ClientStore {
  private listeners = new Set<() => void>();
  private snapshot: { state: ClientState; storageError: string };
  constructor(private readonly key: string) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
      this.snapshot = {
        state: raw ? stateSchema.parse(JSON.parse(raw)) : initialState(),
        storageError: "",
      };
    } catch {
      try {
        if (raw) localStorage.setItem(`${key}:unreadable-backup`, raw);
      } catch {
        /* Keep the original stored value when a backup cannot be written. */
      }
      this.snapshot = {
        state: initialState(),
        storageError:
          "Saved API Client data could not be read. The original data is retained in local storage for recovery.",
      };
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: ClientState, storageError: string) {
    this.snapshot = { state, storageError };
    for (const listener of this.listeners) listener();
  }
  update = (change: (current: ClientState) => ClientState) => {
    try {
      const state = stateSchema.parse(change(this.snapshot.state));
      let storageError = "";
      try {
        localStorage.setItem(this.key, JSON.stringify(state));
      } catch {
        storageError =
          "Unable to save API Client data on this device. Storage may be full. Export your collections before closing.";
      }
      this.publish(state, storageError);
    } catch (error) {
      this.publish(
        this.snapshot.state,
        error instanceof Error ? error.message : "Unable to update API Client data.",
      );
    }
  };
  receive = (event: StorageEvent) => {
    if (event.key !== this.key || !event.newValue) return;
    try {
      this.publish(stateSchema.parse(JSON.parse(event.newValue)), "");
    } catch {
      this.publish(
        this.snapshot.state,
        "API Client data changed in another window but could not be read.",
      );
    }
  };
}
export function useClientStore(hostId: string) {
  const [store] = useState(() => new ClientStore(`mixer:api-client:v1:${hostId}`));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    window.addEventListener("storage", store.receive);
    return () => window.removeEventListener("storage", store.receive);
  }, [store]);
  return { ...snapshot, update: store.update };
}
