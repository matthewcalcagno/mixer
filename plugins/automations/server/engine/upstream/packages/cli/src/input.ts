import fs from "node:fs";
import { z, type JsonValue } from "@mixer/automations-sdk";
import type { Command } from "commander";

export interface InputOptions { input?: string; inputFile?: string; arg?: string[] }

export function inputOptions(command: Command): Command {
  return command.option("--input <json>", "Input as JSON")
    .option("--input-file <path>", "Read JSON from a file, or - for stdin")
    .option("--arg <key=value>", "String input argument; repeat for more arguments", (value: string, previous: string[]) => [...previous, value], []);
}

export function submissionInput(options: InputOptions): JsonValue {
  const args = options.arg ?? [];
  if (Number(options.input !== undefined) + Number(options.inputFile !== undefined) + Number(args.length > 0) > 1) {
    throw new Error("Use only one of --input, --input-file, or --arg");
  }
  let text = options.input;
  if (options.inputFile !== undefined) {
    if (options.inputFile !== "-" && fs.statSync(options.inputFile).size > 48 * 1024) throw new Error("Input exceeds the 48 KiB submission limit");
    text = fs.readFileSync(options.inputFile === "-" ? 0 : options.inputFile, "utf8");
  }
  if (args.length) {
    const input: Record<string, string> = {};
    for (const arg of args) {
      const separator = arg.indexOf("=");
      const key = arg.slice(0, separator);
      if (separator < 1 || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) || ["constructor", "prototype"].includes(key)) throw new Error("--arg requires a simple key=value name");
      if (Object.hasOwn(input, key)) throw new Error(`Duplicate input argument: ${key}`);
      input[key] = arg.slice(separator + 1);
    }
    text = JSON.stringify(input);
  }
  if (Buffer.byteLength(text ?? "{}", "utf8") > 48 * 1024) throw new Error("Input exceeds the 48 KiB submission limit");
  try { return z.json().parse(JSON.parse(text ?? "{}")); }
  catch { throw new Error("Input must be valid JSON"); }
}

export function repositoryOption(options: { repository?: string; repo?: string }): string | undefined {
  if (options.repository && options.repo && options.repository !== options.repo) throw new Error("--repository and --repo cannot specify different repositories");
  return options.repository ?? options.repo;
}
