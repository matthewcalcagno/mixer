import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showWindowWhenReady } from "./show-when-ready.js";

class Window extends EventEmitter {
  webContents = new EventEmitter();
  shows = 0;
  destroyed = false;
  show() {
    this.shows += 1;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
}
afterEach(() => vi.useRealTimers());
describe("showWindowWhenReady", () => {
  it("waits two minutes by default before showing the startup warning", () => {
    vi.useFakeTimers();
    const win = new Window();
    const timeout = vi.fn();
    showWindowWhenReady(win, { onTimeout: timeout });
    vi.advanceTimersByTime(119999);
    expect(win.shows).toBe(0);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.shows).toBe(1);
    expect(timeout).toHaveBeenCalledOnce();
  });
  it("shows the ready IDE even if a hidden window never emits a paint event", () => {
    vi.useFakeTimers();
    const win = new Window();
    const focus = vi.fn();
    const gate = showWindowWhenReady(win, { onShown: focus });
    expect(focus).not.toHaveBeenCalled();
    gate.ready();
    expect(win.shows).toBe(1);
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
    expect(focus).toHaveBeenCalledOnce();
  });
  it("keeps readiness isolated between windows", () => {
    vi.useFakeTimers();
    const first = new Window();
    const second = new Window();
    const firstGate = showWindowWhenReady(first);
    showWindowWhenReady(second);
    first.webContents.emit("did-finish-load");
    second.webContents.emit("did-finish-load");
    firstGate.ready();
    expect(first.shows).toBe(1);
    expect(second.shows).toBe(0);
  });
  it("keeps the first painted frame hidden until the IDE is ready", () => {
    vi.useFakeTimers();
    const win = new Window();
    const gate = showWindowWhenReady(win);
    win.emit("ready-to-show");
    expect(win.shows).toBe(0);
    gate.ready();
    expect(win.shows).toBe(1);
    gate.ready();
    expect(win.shows).toBe(1);
  });
  it("allows Linux document readiness without revealing an unfinished IDE", () => {
    vi.useFakeTimers();
    const win = new Window();
    const gate = showWindowWhenReady(win);
    win.webContents.emit("did-finish-load");
    expect(win.shows).toBe(0);
    gate.ready();
    expect(win.shows).toBe(1);
  });
  it("holds early show requests from deep links until startup finishes", () => {
    vi.useFakeTimers();
    const win = new Window();
    const gate = showWindowWhenReady(win);
    gate.show();
    expect(win.shows).toBe(0);
    win.emit("ready-to-show");
    gate.ready();
    expect(win.shows).toBe(1);
  });
  it("reveals a recoverable window when startup times out", () => {
    vi.useFakeTimers();
    const win = new Window();
    const timeout = vi.fn();
    showWindowWhenReady(win, { timeoutMs: 10000, onTimeout: timeout });
    vi.advanceTimersByTime(9999);
    expect(win.shows).toBe(0);
    vi.advanceTimersByTime(1);
    expect(win.shows).toBe(1);
    expect(timeout).toHaveBeenCalledOnce();
  });
  it("never reveals a closed window on readiness or timeout", () => {
    vi.useFakeTimers();
    const win = new Window();
    const gate = showWindowWhenReady(win);
    win.close();
    win.webContents.emit("did-finish-load");
    win.emit("ready-to-show");
    gate.ready();
    vi.advanceTimersByTime(120001);
    expect(win.shows).toBe(0);
  });
});
