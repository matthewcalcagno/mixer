/** Monaco's public API does not export its cancellation predicate. Match its CancellationError shape. */
export function isEditorCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "Canceled" && error.message === "Canceled";
}
