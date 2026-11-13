import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hash, realDirectory, SLUG } from "./definitions.js";
import type { Attempt, Batch, OpenBatch } from "./model.js";

export function reportDirectory(root: string, slug: string): string {
  if (!SLUG.test(slug)) throw new Error("Invalid evaluation folder");
  realDirectory(root);
  const folder = path.join(root, slug);
  realDirectory(folder);
  const directory = path.join(folder, "reports");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  realDirectory(directory);
  return directory;
}

export function reportPath(root: string, slug: string, file: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z_eval_[a-f0-9]{24}\.md$/.test(file)) throw new Error("Invalid generated report filename");
  return path.join(reportDirectory(root, slug), file);
}

export function writeReport(root: string, batch: Extract<Batch, { state: "reporting" }>): void {
  const target = reportPath(root, batch.slug, batch.reportFile);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576 || hash(fs.readFileSync(target, "utf8")) !== batch.reportHash) {
      throw new Error("Existing evaluation report differs; refusing to overwrite it");
    }
    return;
  }
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, batch.reportBody); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Link installs a complete file without overwriting a report from another delivery.
    fs.linkSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function text(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quote(value: string): string {
  return text(value).split("\n").map((line) => `> ${line}`).join("\n");
}

export function renderReport(batch: OpenBatch, attempt: Attempt): string {
  const judgment = attempt.kind === "judgment" ? attempt.judgment : undefined;
  const result = attempt.kind === "error" ? "Evaluation error" : !judgment || judgment.criteria.some((item) => item.result === "insufficient-evidence")
    ? "Insufficient evidence" : judgment.suggestion ? "Improvement suggested" : judgment.criteria.some((item) => item.result === "fail")
      ? "Criteria not met; no instruction change justified" : "No change justified";
  const lines = [
    `# Evaluation: ${batch.slug}`, "", `Result: ${result}`, `Batch: ${batch.id}`,
    `Evaluator run: ${batch.state === "active" ? batch.runId : "not invoked"}`,
    `Created: ${new Date(batch.createdAt).toISOString()}`, `Workflow: ${batch.definition.workflow}`,
    `Workflow version: ${batch.workflowVersion}`, `Evaluation version: ${batch.definitionVersion}`,
    `Harness: ${batch.definition.agent}`, `Model: ${batch.definition.model ?? "harness default"}`,
    `Thinking: ${batch.definition.thinking ?? "harness default"}`, "", "## Source runs", "",
    ...batch.runIds.map((id) => `- ${id}`), "", "## Findings", "",
  ];
  if (judgment) for (const item of judgment.criteria) {
    const criterion = batch.definition.criteria[item.criterion - 1];
    lines.push(`### ${item.criterion}. ${criterion?.description ?? "Unknown criterion"}`, "", `Result: ${item.result}`, "",
      "Pass when:", "", quote(criterion?.passWhen ?? ""), "", text(item.explanation), "");
    for (const evidence of item.evidence) lines.push(`Source: ${evidence.runId}`, "", quote(evidence.excerpt), "");
  }
  else lines.push(attempt.kind === "error" || attempt.kind === "inconclusive" ? attempt.reason : "The evaluator did not produce a valid result.", "");
  lines.push("## Suggested improvement", "", text(judgment?.suggestion ?? "No change proposed."), "",
    "## Limitations", "", "Findings apply only to the captured evidence. Agent claims are not independent verification of published effects.",
    "Source logs may expire. Cited excerpts are retained in this report only for its configured retention period.",
    "Host harness execution is not a security sandbox. No Safe Actions or automatic automation edits are authorized.", "",
    "No automation files were changed by the evaluations extension.", "");
  return lines.join("\n");
}
