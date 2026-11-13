import { runResultSchema, type runSchema } from "./contracts.js";

export function runStatusTone(
  run: Pick<(typeof runSchema)["_output"], "status" | "sourceStatus">,
): "success" | "warning" | "danger" | "muted" {
  if (
    run.status === "failed" ||
    run.status === "interrupted" ||
    run.status === "attention" ||
    run.sourceStatus === "cancelled"
  )
    return "danger";
  if (run.status === "running") return "warning";
  if (run.status === "succeeded") return "success";
  return "muted";
}

export function readRunResult(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = runResultSchema.safeParse(JSON.parse(value));
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function inspectRunResult(run: (typeof runSchema)["_output"]) {
  if (run.result) return run.result;
  if (run.engine) return undefined;
  const last = run.output.trimEnd().split("\n").at(-1) ?? "";
  const prefix = "MIXER_AUTOMATIONS_RESULT:";
  return readRunResult(last.startsWith(prefix) ? last.slice(prefix.length) : run.output);
}

export function runOverviewSummary(run: (typeof runSchema)["_output"]): string {
  if (run.status === "running") return "This workflow is running";
  if (run.status === "queued") return "This workflow is queued";
  const result = inspectRunResult(run);
  if (result?.reason) return result.reason;
  if (!run.engine && run.trigger !== "imported" && run.output) return run.output;
  return "No result recorded.";
}

export function classifyRunLogLine(line: string) {
  if (line.startsWith("$ ")) return "command";
  if (line.startsWith("> ")) return "heading";
  if (/^[→⚙] /u.test(line)) return "tool";
  if (/^ERROR\b/.test(line)) return "error";
  if (/^WARN\b/.test(line)) return "warning";
  return "output";
}

function readableLogRecord(record: unknown): { text: string; chunk: boolean } {
  if (record === null || typeof record !== "object") {
    return { text: `${typeof record === "string" ? record : String(record)}\n`, chunk: false };
  }
  if ("chunk" in record && typeof record.chunk === "string") {
    return { text: record.chunk, chunk: true };
  }
  if (!("msg" in record) || typeof record.msg !== "string") {
    return { text: `${JSON.stringify(record)}\n`, chunk: false };
  }
  let prefix = "";
  if ("level" in record && typeof record.level === "number") {
    if (record.level >= 50) prefix = "ERROR  ";
    else if (record.level >= 40) prefix = "WARN   ";
  }
  return { text: `${prefix}${record.msg}\n`, chunk: false };
}

export function inspectRunLogs(output: string): { language: "text"; content: string } {
  if (!output.trim()) return { language: "text", content: "No output yet." };
  let records: unknown[];
  try {
    const parsed: unknown = JSON.parse(output);
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    records = output.split("\n").map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed;
      } catch {
        return line;
      }
    });
  }
  let content = "";
  let endsWithChunk = false;
  for (const record of records) {
    const formatted = readableLogRecord(record);
    if (!formatted.chunk && content && !content.endsWith("\n")) content += "\n";
    content += formatted.text;
    endsWithChunk = formatted.chunk;
  }
  // Process streams contain terminal colors and cursor controls, not printable text.
  const escape = String.fromCharCode(27);
  const ansi = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g");
  const osc = new RegExp(
    `${escape}\\][^${escape}${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${escape}\\\\)`,
    "g",
  );
  if (!endsWithChunk) content = content.replace(/\n$/, "");
  return {
    language: "text",
    content: content.replace(osc, "").replace(ansi, "").replace(/\r\n?/g, "\n"),
  };
}
