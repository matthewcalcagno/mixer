import { describe, expect, test } from "vitest";
import { isEditorCancellation } from "./errors";

describe("editor cancellation", () => {
  test("ignores Monaco's routine cancellation without suppressing editor failures", () => {
    const canceled = new Error("Canceled");
    canceled.name = "Canceled";
    expect(isEditorCancellation(canceled)).toBe(true);
    expect(isEditorCancellation(new Error("Canceled"))).toBe(false);
    expect(isEditorCancellation(new Error("Language server failed"))).toBe(false);
    expect(isEditorCancellation({ name: "Canceled", message: "Canceled" })).toBe(false);
  });
});
