import { getDesktopHost, type DesktopDialogAskOptions } from "@/desktop/host";
export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
interface ConfirmButtonConfig {
  confirmLabel: string;
  cancelLabel: string;
}
function resolveButtonLabels(input: ConfirmDialogInput): ConfirmButtonConfig {
  return {
    confirmLabel: input.confirmLabel ?? "Confirm",
    cancelLabel: input.cancelLabel ?? "Cancel",
  };
}
function getDesktopApi() {
  return getDesktopHost();
}
function buildDesktopAskOptions(input: ConfirmDialogInput): DesktopDialogAskOptions {
  const labels = resolveButtonLabels(input);
  return {
    title: input.title,
    okLabel: labels.confirmLabel,
    cancelLabel: labels.cancelLabel,
    kind: input.destructive ? "warning" : "info",
  };
}
function blurActiveWebElement(): void {
  const activeElement = (
    globalThis as {
      document?: Document;
    }
  ).document?.activeElement;
  (activeElement as HTMLElement | null)?.blur?.();
}
async function showDesktopConfirmDialog(input: ConfirmDialogInput): Promise<boolean | null> {
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    return null;
  }
  blurActiveWebElement();
  const options = buildDesktopAskOptions(input);
  const desktopAsk = desktopApi.dialog?.ask;
  if (typeof desktopAsk === "function") {
    return await desktopAsk(input.message, options);
  }
  return null;
}
function showWebConfirmDialog(input: ConfirmDialogInput): boolean {
  const browserConfirm = (
    globalThis as {
      confirm?: (message?: string) => boolean;
    }
  ).confirm;
  if (typeof browserConfirm !== "function") {
    throw new Error("[ConfirmDialog] No web confirmation backend is available.");
  }
  blurActiveWebElement();
  const promptMessage = `${input.title}\n\n${input.message}`;
  return browserConfirm(promptMessage);
}
export async function confirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  const desktopResult = await showDesktopConfirmDialog(input);
  if (desktopResult !== null) {
    return desktopResult;
  }
  return showWebConfirmDialog(input);
}
export const __private__ = {
  blurActiveWebElement,
  buildDesktopAskOptions,
};
