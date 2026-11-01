import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { resolveRipgrepPath } from "@mixer/plugin/server";
import { searchWorkspace } from "../server/search.js";

const root = await mkdtemp(path.join(tmpdir(), "mixer-search-bench-"));
try {
  await promisify(execFile)("git", ["init", "--quiet", root]);
  await mkdir(path.join(root, "src"));
  const fileCount = 1500;
  for (let offset = 0; offset < fileCount; offset += 50) {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const number = offset + index;
        const body =
          "export const value = 'example text';\n".repeat(40) +
          (number % 250 === 0 ? "unique_search_token\n" : "");
        return writeFile(path.join(root, "src", `${number}.ts`), body);
      }),
    );
  }
  const times: number[] = [];
  const ripgrepPath = await resolveRipgrepPath();
  for (let index = 0; index < 6; index++) {
    const result = await searchWorkspace({
      root,
      ripgrepPath,
      signal: new AbortController().signal,
      options: {
        query: "unique_search_token",
        regex: false,
        wholeWord: false,
        caseSensitive: false,
        includes: "",
        excludes: "",
        respectIgnore: true,
      },
    });
    assert.equal(result.count, 6);
    assert.equal(result.limited, false);
    times.push(result.elapsedMs);
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        fileCount,
        matches: 6,
        firstRunMs: times[0],
        medianWarmMs: warm[2],
        p95WarmMs: warm[4],
        inputDebounceMs: 150,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
