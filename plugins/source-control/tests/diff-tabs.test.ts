import { test } from "vitest";
import assert from "node:assert/strict";
import { diffTabSchema } from "../shared/diff-tabs.js";

test("restores legacy diff slot IDs and selections while the host owns preview behavior", () => {
  const saved = {
    id: "diff-slot-77-1",
    workspaceId: "workspace",
    selection: { path: "price.tsx", staged: true },
    pinned: false,
  };
  assert.deepEqual(diffTabSchema.parse(saved), saved);
});
test("refuses corrupt legacy diff entries instead of registering missing targets", () => {
  assert.throws(() =>
    diffTabSchema.parse({
      id: "",
      workspaceId: "workspace",
      selection: { path: "price.tsx", staged: true },
      pinned: false,
    }),
  );
  assert.throws(() =>
    diffTabSchema.parse({
      id: "diff-slot",
      workspaceId: "workspace",
      selection: { path: "", staged: false },
      pinned: false,
    }),
  );
});
