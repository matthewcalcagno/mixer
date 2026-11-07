/** Hidden windows may not produce animation frames. Wait for two commits using tasks instead. */
export function scheduleStartupReveal(callback: () => void): () => void {
  let timer = setTimeout(() => {
    timer = setTimeout(callback, 0);
  }, 0);
  return () => clearTimeout(timer);
}

export const STARTUP_RECOVERY_DELAY_MS = 5000;
