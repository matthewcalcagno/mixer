interface NativeUpdater {
  on(event: "update-downloaded", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "update-downloaded", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): void;
}

interface MacUpdatePreparationInput {
  updater: NativeUpdater;
  signal: AbortSignal;
  download(): Promise<unknown>;
}

// electron-updater's ZIP download event precedes Squirrel.Mac's native staging.
export function prepareMacUpdate({
  updater,
  signal,
  download,
}: MacUpdatePreparationInput): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      updater.removeListener("update-downloaded", ready);
      updater.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const ready = () => {
      settled = true;
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      settled = true;
      cleanup();
      reject(error);
    };
    const aborted = () =>
      failed(
        new Error(
          "macOS update preparation was cancelled or timed out. Retry the update or install the latest DMG manually.",
        ),
      );
    if (signal.aborted) {
      aborted();
      return;
    }
    updater.on("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    void download()
      .then(() => {
        if (!settled) {
          updater.on("update-downloaded", ready);
          updater.checkForUpdates();
        }
        return undefined;
      })
      .catch((error: unknown) => {
        failed(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
