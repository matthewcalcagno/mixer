export const DESKTOP_STARTUP_TIMEOUT_MS = 10000;

interface StartupWindow {
  once(event: "closed", listener: () => void): unknown;
  show(): void;
  isDestroyed(): boolean;
}
const revealRequests = new WeakMap<object, () => boolean>();
export function requestWindowShow(win: { show(): void; isDestroyed(): boolean }): boolean {
  if (win.isDestroyed()) return false;
  const reveal = revealRequests.get(win);
  if (reveal) return reveal();
  win.show();
  return true;
}

export function showWindowWhenReady(
  win: StartupWindow,
  options: {
    timeoutMs?: number;
    onTimeout?: () => void;
    onBeforeShow?: () => void;
    onShown?: () => void;
  } = {},
): { ready(): void; show(): boolean } {
  let shown = false;
  let rendererReady = false;
  const show = () => {
    if (win.isDestroyed()) return false;
    if (!shown && !rendererReady) return false;
    if (shown) {
      win.show();
      return true;
    }
    shown = true;
    clearTimeout(timer);
    options.onBeforeShow?.();
    win.show();
    options.onShown?.();
    return true;
  };
  const timer = setTimeout(() => {
    if (shown || win.isDestroyed()) return;
    rendererReady = true;
    show();
    options.onTimeout?.();
  }, options.timeoutMs ?? DESKTOP_STARTUP_TIMEOUT_MS);
  revealRequests.set(win, show);
  win.once("closed", () => {
    clearTimeout(timer);
    revealRequests.delete(win);
  });
  return {
    ready: () => {
      rendererReady = true;
      if (!shown) show();
    },
    show,
  };
}
