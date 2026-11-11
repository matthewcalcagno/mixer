import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  splitGlobs,
  type SearchOptions,
  type SearchResult,
  type SearchMatch,
} from "../shared/search.js";

export const MAX_RESULTS = 1000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const DEADLINE_MS = 5000;
const execute = promisify(execFile);
const rgText = z.union([z.object({ text: z.string() }), z.object({ bytes: z.string() })]);
const rgEnvelope = z.object({ type: z.string(), data: z.unknown() });
const rgMatch = z.object({
  path: rgText,
  lines: rgText,
  line_number: z.number().int().positive(),
  submatches: z.array(
    z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  ),
});

export function searchArguments(options: SearchOptions): string[] {
  const args = [
    "--json",
    "--line-buffered",
    "--no-config",
    "--no-require-git",
    "--color",
    "never",
    "--hidden",
    "--max-filesize",
    "2M",
  ];
  args.push(options.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (!options.regex) args.push("--fixed-strings");
  if (options.wholeWord) args.push("--word-regexp");
  if (!options.respectIgnore) args.push("--no-ignore");
  for (const pattern of splitGlobs(options.includes)) args.push(`--glob=${pattern}`);
  for (const pattern of splitGlobs(options.excludes)) args.push(`--glob=!${pattern}`);
  args.push("--glob=!.git", "--glob=!**/.git/**", `--regexp=${options.query}`, "--", ".");
  return args;
}

interface SearchInput {
  root: string;
  ripgrepPath: string;
  options: SearchOptions;
  signal: AbortSignal;
}
function resultPath(value: string): string {
  return value.replace(/^\.[\\/]/, "").replace(/\\/g, "/");
}

async function allowedFileScope({
  root,
  ripgrepPath,
  options,
  signal,
}: SearchInput): Promise<Set<string>> {
  // Positive rg globs override ignore rules. Its independent file listing keeps
  // the ignore checkbox authoritative without reimplementing Git's pattern rules.
  const args = ["--files", "--null", "--hidden", "--no-config", "--no-require-git"];
  for (const pattern of splitGlobs(options.excludes)) args.push(`--glob=!${pattern}`);
  args.push("--glob=!.git", "--glob=!**/.git/**", "--", ".");
  try {
    const { stdout } = await execute(ripgrepPath, args, {
      cwd: root,
      signal,
      timeout: DEADLINE_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    });
    const paths = stdout.split("\0").filter(Boolean).map(resultPath);
    return new Set(paths);
  } catch (error) {
    if (signal.aborted) return new Set<string>();
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1)
      return new Set<string>();
    throw new Error(
      "Unable to read search scope within its time/output budget. Narrow the file exclusions or retry.",
      { cause: error },
    );
  }
}

export async function searchWorkspace(input: SearchInput): Promise<SearchResult> {
  const { root, ripgrepPath, options, signal } = input;
  const started = performance.now();
  const args = searchArguments(options);
  const limit = options.limit ?? MAX_RESULTS;
  const files = new Map<string, SearchMatch[]>();
  let count = 0;
  let reason: SearchResult["limitReason"] = null;
  function result(): SearchResult {
    const entries = Array.from(files, ([path, matches]) => ({ path, matches }));
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      status: signal.aborted ? "cancelled" : "complete",
      files: entries,
      count,
      limited: reason !== null,
      limitReason: reason,
      elapsedMs: performance.now() - started,
    };
  }
  if (signal.aborted) return result();
  const hasPositiveIncludes = splitGlobs(options.includes).some(
    (pattern) => !pattern.startsWith("!"),
  );
  const needsIgnoreScope = options.respectIgnore && hasPositiveIncludes;
  const scope = needsIgnoreScope ? await allowedFileScope(input) : null;
  if (signal.aborted || scope?.size === 0) return result();
  return new Promise((resolve, reject) => {
    const child = spawn(ripgrepPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const decoder = new StringDecoder("utf8");
    let tail = "";
    let bytes = 0;
    let stderr = "";
    let failure: Error | null = null;
    const cancel = () => {
      child.kill("SIGTERM");
    };
    const remaining = Math.max(1, DEADLINE_MS - (performance.now() - started));
    const timer = setTimeout(() => {
      reason = "timeout";
      cancel();
    }, remaining);
    signal.addEventListener("abort", cancel, { once: true });
    child.on("error", (error) => {
      failure = error;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    function consume(line: string) {
      const envelope = rgEnvelope.parse(JSON.parse(line));
      if (envelope.type !== "match") return;
      const match = rgMatch.parse(envelope.data);
      if (!("text" in match.path) || !("text" in match.lines)) return;
      const path = resultPath(match.path.text);
      if (scope && !scope.has(path)) return;
      const raw = match.lines.text.replace(/\r?\n$/, "");
      const encoded = Buffer.from(raw, "utf8");
      const found = files.get(path) ?? [];
      for (const part of match.submatches) {
        const start = encoded.subarray(0, part.start).toString("utf8").length;
        const end = encoded.subarray(0, part.end).toString("utf8").length;
        const from = Math.max(0, start - 60);
        const to = Math.min(raw.length, Math.max(end, start + 1) + 160);
        const preview = raw.slice(from, Math.min(to, from + 320));
        found.push({
          line: match.line_number,
          column: start + 1,
          preview,
          start: start - from,
          end: Math.min(end - from, preview.length),
        });
        count++;
        if (count >= limit) {
          reason = "results";
          cancel();
          break;
        }
      }
      files.set(path, found);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (reason || signal.aborted || failure) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        reason = "output";
        cancel();
        return;
      }
      tail += decoder.write(chunk);
      let end = tail.indexOf("\n");
      try {
        while (end !== -1 && !reason) {
          const line = tail.slice(0, end);
          tail = tail.slice(end + 1);
          if (line) consume(line);
          end = tail.indexOf("\n");
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Invalid search output");
        cancel();
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (!signal.aborted && !reason && code !== 0 && code !== 1)
        reject(new Error(stderr.trim() || `Search engine exited with code ${code}`));
      else resolve(result());
    });
  });
}
