import assert from "node:assert/strict";
import { test } from "vitest";
import { getRawFileIconSvg } from "../client/vendor/material-file-icons.js";
import data from "../client/vendor/material-file-icons.generated.json";

test("Source Control resolves language and specialized file icons", () => {
  const icons: Record<string, string> = data.icons;
  for (const [path, icon] of [
    ["code/src/config/query-params.ts", "typescript"],
    ["src/main.js", "javascript"],
    ["config.yml", "yaml"],
    ["src/main.py", "python"],
    ["src/main.rs", "rust"],
    ["src/main.test.ts", "test-ts"],
  ]) {
    assert.equal(getRawFileIconSvg(path), icons[icon], path);
  }
});
