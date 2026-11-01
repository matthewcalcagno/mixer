import { dialog, ipcMain, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

const saveTextOptionsSchema = z.strictObject({
  content: z
    .string()
    .refine(
      (content) => Buffer.byteLength(content, "utf8") <= 1024 * 1024,
      "File exceeds the 1 MiB editing limit",
    ),
  defaultPath: z.string().max(4096).optional(),
});

export async function saveTextWithNativeDialog(
  input: unknown,
  window: BrowserWindow,
): Promise<string | null> {
  const options = saveTextOptionsSchema.parse(input);
  const result = await dialog.showSaveDialog(window, {
    title: "Save file",
    defaultPath: options.defaultPath,
    filters: [{ name: "All Files", extensions: ["*"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return null;
  // Only the native dialog's selection authorizes the write. Renderer paths are hints, never write targets.
  await writeFile(result.filePath, options.content, "utf8");
  return result.filePath;
}

interface AskOptions {
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "info" | "warning" | "error";
}

interface AskWithCheckboxOptions extends AskOptions {
  checkboxLabel: string;
  checkboxChecked?: boolean;
}

interface OpenOptions {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  createDirectory?: boolean;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

function resolveDialogType(kind: AskOptions["kind"]): "warning" | "error" | "question" {
  if (kind === "warning") return "warning";
  if (kind === "error") return "error";
  return "question";
}

export function registerDialogHandlers(): void {
  ipcMain.handle("mixer:dialog:saveText", async (event, input: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Save requires the application window");
    return saveTextWithNativeDialog(input, window);
  });
  ipcMain.handle("mixer:dialog:ask", async (event, message: string, options?: AskOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showMessageBox(win ?? BrowserWindow.getFocusedWindow()!, {
      type: resolveDialogType(options?.kind),
      title: options?.title ?? "Confirm",
      message,
      buttons: [options?.cancelLabel ?? "Cancel", options?.okLabel ?? "OK"],
      defaultId: 1,
      cancelId: 0,
    });
    return result.response === 1;
  });

  ipcMain.handle(
    "mixer:dialog:askWithCheckbox",
    async (event, message: string, options: AskWithCheckboxOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showMessageBox(win ?? BrowserWindow.getFocusedWindow()!, {
        type: resolveDialogType(options.kind),
        title: options.title ?? "Confirm",
        message,
        buttons: [options.cancelLabel ?? "Cancel", options.okLabel ?? "OK"],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: options.checkboxLabel,
        checkboxChecked: options.checkboxChecked ?? false,
      });
      return {
        confirmed: result.response === 1,
        dontAskAgain: result.checkboxChecked,
      };
    },
  );

  ipcMain.handle("mixer:dialog:open", async (event, options?: OpenOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const properties: Electron.OpenDialogOptions["properties"] = [];
    if (options?.directory) properties.push("openDirectory");
    if (options?.createDirectory) properties.push("createDirectory");
    if (options?.multiple) properties.push("multiSelections");
    if (!options?.directory) properties.push("openFile");

    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      properties,
      filters: options?.filters,
    });

    if (result.canceled) return null;
    return options?.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  });
}
