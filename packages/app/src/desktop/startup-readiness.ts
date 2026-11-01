import { useCallback, useLayoutEffect, useRef } from "react";
import { getDesktopHost } from "./host";

interface StartupSnapshot {
  pending: readonly string[];
  revision: number;
  completed: boolean;
}
const noOp = () => {};
export class StartupReadiness {
  private holds = new Map<symbol, string>();
  private listeners = new Set<() => void>();
  private snapshot: StartupSnapshot = { pending: [], revision: 0, completed: false };
  getSnapshot = (): StartupSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  hold(label: string): () => void {
    if (this.snapshot.completed) return noOp;
    const id = Symbol(label);
    this.holds.set(id, label);
    this.publish(false);
    return () => {
      if (this.holds.delete(id)) this.publish(false);
    };
  }
  complete(): void {
    if (this.snapshot.completed || this.holds.size > 0) return;
    this.publish(true);
  }
  private publish(completed: boolean): void {
    this.snapshot = {
      pending: [...this.holds.values()],
      revision: this.snapshot.revision + 1,
      completed,
    };
    for (const listener of this.listeners) listener();
  }
}
export const desktopStartup = new StartupReadiness();

/** Layout effects register before the startup gate considers a frame ready. */
export function useDesktopStartupBlocker(label: string, blocked: boolean): () => void {
  const releaseRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!blocked || !getDesktopHost()?.startup) return;
    const release = desktopStartup.hold(label);
    releaseRef.current = release;
    return () => {
      release();
      if (releaseRef.current === release) releaseRef.current = null;
    };
  }, [blocked, label]);
  return useCallback(() => releaseRef.current?.(), []);
}
