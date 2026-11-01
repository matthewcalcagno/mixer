import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow, dialog } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveTextWithNativeDialog } from "./dialogs.js";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(function FakeBrowserWindow() {
    return { id: 1 };
  }),
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "mixer-native-save-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("writes only to the native dialog's selected path, including confirmed replacement", async () => {
  const selected = path.join(directory, "selected.txt");
  const hint = path.join(directory, "hint.txt");
  await writeFile(selected, "old content");
  await writeFile(hint, "keep this file");
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: selected });
  const window = new BrowserWindow();
  expect(
    await saveTextWithNativeDialog({ content: "new content", defaultPath: hint }, window),
  ).toBe(selected);
  expect(await readFile(selected, "utf8")).toBe("new content");
  expect(await readFile(hint, "utf8")).toBe("keep this file");
  expect(dialog.showSaveDialog).toHaveBeenCalledWith(
    window,
    expect.objectContaining({
      defaultPath: hint,
      properties: ["createDirectory", "showOverwriteConfirmation"],
    }),
  );
});

it("leaves files unchanged when the user cancels", async () => {
  const selected = path.join(directory, "notes.txt");
  await writeFile(selected, "keep this file");
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: selected });
  expect(
    await saveTextWithNativeDialog(
      { content: "discarded", defaultPath: selected },
      new BrowserWindow(),
    ),
  ).toBeNull();
  expect(await readFile(selected, "utf8")).toBe("keep this file");
});

it("rejects oversized content before opening the dialog", async () => {
  await expect(
    saveTextWithNativeDialog({ content: "x".repeat(1024 * 1024 + 1) }, new BrowserWindow()),
  ).rejects.toThrow("1 MiB");
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});
