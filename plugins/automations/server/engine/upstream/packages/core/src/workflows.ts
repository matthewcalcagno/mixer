import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { LineCounter, isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import type { Workflow, WorkflowDiscovery, WorkflowError } from "@mixer/automations-sdk";
import type { Registry } from "./registry.js";

const repositorySchema = z.string().regex(/^[^\s/]+\/[^\s/]+$/, "repository must use owner/repo format");
const repositoriesSchema = z.union([
  repositorySchema,
  z.array(repositorySchema).min(1, "at least one repository is required").refine(
    (repositories) => new Set(repositories).size === repositories.length,
    "repositories must be unique",
  ),
]);
const safeActionPolicySchema = z.object({ max: z.number().int().positive() }).loose();
const baseFrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  disabled: z.boolean().default(false),
  repository: repositoriesSchema.optional(),
  workspace: z.string().min(1).optional(),
  on: z.record(z.string(), z.unknown()),
  agent: z.string().min(1).default("codex"),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  safeActions: z.record(z.string().min(1), safeActionPolicySchema).default({}),
}).loose();
const coreFields = new Set(["name", "disabled", "repository", "workspace", "on", "agent", "model", "thinking", "safeActions"]);

export type { WorkflowDiscovery, WorkflowError } from "@mixer/automations-sdk";

export function workflowRepositories(workflow: Pick<Workflow, "repository">): readonly string[] {
  if (!workflow.repository) return [];
  return typeof workflow.repository === "string" ? [workflow.repository] : workflow.repository;
}

export function workflowAllowsRepository(workflow: Pick<Workflow, "repository">, repository: string | undefined): boolean {
  const repositories = workflowRepositories(workflow);
  return repositories.length === 0 || (repository !== undefined && repositories.includes(repository));
}

function workflowFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? workflowFiles(absolute) : entry.isFile() && /\.(md|yaml|yml)$/.test(entry.name) ? [absolute] : [];
  });
}

export function resolveWorkflowFile(root: string, identifier: string): string | undefined {
  const normalized = identifier.replace(/^\.\//, "");
  const files = workflowFiles(root);
  const exact = files.find((file) => path.relative(root, file).split(path.sep).join("/") === normalized);
  if (exact) return exact;
  const matches = files.filter((file) => path.relative(root, file).split(path.sep).join("/").replace(/\.(md|yaml|yml)$/, "") === normalized);
  if (matches.length > 1) throw new Error(`Ambiguous workflow '${identifier}'; specify a filename including its extension`);
  return matches[0];
}

export function parseWorkflow(file: string, root: string, registry?: Registry): Workflow {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (fs.statSync(file).size > 1024 * 1024) throw new Error("workflow exceeds the 1 MiB size limit");
  const source = fs.readFileSync(file, "utf8");
  const scripted = /\.ya?ml$/.test(file);
  const lines = new LineCounter();
  const parseYaml = (text: string): Record<string, unknown> => {
    const document = parseDocument(text, { version: "1.2", uniqueKeys: true, merge: false, lineCounter: lines });
    if (document.errors.length || document.warnings.length) throw new Error([...document.errors, ...document.warnings].map((error) => error.message).join("; "));
    if (document.directives?.yaml.version !== "1.2") throw new Error("Workflow YAML must use version 1.2");
    visit(document, (_key, node) => {
      if (isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value)) throw new Error("Non-finite YAML numbers cannot be persisted");
    });
    const value: unknown = document.toJS({ maxAliasCount: 10 });
    // Workflow snapshots must survive JSON persistence, including extension fields.
    JSON.stringify(value);
    return z.record(z.string(), z.unknown()).parse(value);
  };
  const parsed = scripted ? { data: parseYaml(source), content: "" } : matter(source, { engines: { yaml: parseYaml } });
  const { steps, env, defaults, ...metadata } = parsed.data;
  if (!scripted && [steps, env, defaults].some((value) => value !== undefined)) throw new Error("steps, env and defaults require a .yaml or .yml workflow");
  if (scripted) {
    for (const key of ["agent", "model", "thinking"]) if (key in metadata) throw new Error(`${key} is not supported in scripted workflows`);
    const runner = registry?.workflowRunners.get("steps");
    if (!runner) throw new Error("The steps workflow runner is unavailable; enable the steps extension");
    const result = runner.schema.safeParse({ steps, ...(env === undefined ? {} : { env }), ...(defaults === undefined ? {} : { defaults }) });
    if (!result.success) {
      const document = parseDocument(source);
      throw new Error(result.error.issues.map((issue) => {
        const node = document.getIn(issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"), true);
        const position = node && typeof node === "object" && "range" in node && Array.isArray(node.range) ? lines.linePos(node.range[0]) : undefined;
        return `${position ? `${position.line}:${position.col} ` : ""}${issue.path.join(".")}: ${issue.message}`;
      }).join("; "));
    }
  }
  const data = baseFrontmatterSchema.parse(metadata);
  const extensions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (coreFields.has(name)) continue;
    const definition = registry?.workflowFieldDefinitions.get(name);
    if (!definition) throw new Error(`Unrecognized key; unknown workflow frontmatter field: ${name}`);
    const result = definition.schema.safeParse(value);
    if (!result.success) throw new Error(`Invalid workflow frontmatter field ${name}: ${result.error.issues[0]?.message ?? "invalid"}`);
    extensions[name] = result.data;
  }
  return {
    id: relative,
    path: file,
    name: data.name ?? relative.replace(/\.(md|yaml|yml)$/, ""),
    disabled: data.disabled,
    repository: data.repository,
    on: data.on,
    extensions,
    agent: scripted ? "" : data.agent,
    model: data.model,
    thinking: data.thinking,
    execution: "host",
    workspace: data.workspace ?? (data.repository ? "worktree" : "scratch"),
    safeActions: data.safeActions,
    prompt: parsed.content.trim(),
    ...(scripted ? { task: { kind: "steps" as const, runner: "steps", configuration: { steps, ...(env === undefined ? {} : { env }), ...(defaults === undefined ? {} : { defaults }) } } } : {}),
  };
}

export function validateWorkflow(workflow: Workflow, registry: Registry): string[] {
  const errors: string[] = [];
  if (workflow.task) {
    const runner = registry.workflowRunners.get(workflow.task.runner);
    if (!runner) errors.push(`Unknown workflow runner: ${workflow.task.runner}`);
    else {
      const result = runner.schema.safeParse(workflow.task.configuration);
      if (!result.success) errors.push(`Invalid steps: ${result.error.message}`);
    }
  } else if (!registry.agentProviders.has(workflow.agent)) errors.push(`Unknown agent: ${workflow.agent}`);
  if (!registry.executionProviders.has("host")) errors.push("Host execution provider is unavailable");
  const workspace = workflow.workspace ?? (workflow.repository ? "worktree" : "scratch");
  if (!registry.workspaceProviders.has(workspace)) errors.push(`Unknown workspace provider: ${workspace}`);
  if (workspace === "worktree" && !workflow.repository) errors.push("Worktree workspace requires repository");
  for (const [name, policy] of Object.entries(workflow.safeActions)) {
    const definition = registry.actionDefinitions.get(name);
    if (!definition) {
      errors.push(`Unknown Safe Action: ${name}`);
      continue;
    }
    const result = definition.policySchema?.safeParse(policy);
    if (result && !result.success) errors.push(`Invalid policy for Safe Action ${name}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  for (const type of Object.keys(workflow.on)) {
    const source = registry.eventSources.get(type);
    if (!source) {
      errors.push(`Unknown event source: ${type}`);
      continue;
    }
    const result = source.configSchema?.safeParse(workflow.on[type]);
    if (result && !result.success) {
      errors.push(`Invalid configuration for ${type}: ${result.error.issues[0]?.message ?? "invalid"}`);
    }
  }
  return errors;
}

export function discoverWorkflows(root: string, registry?: Registry): WorkflowDiscovery {
  const workflows: Workflow[] = [];
  const errors: WorkflowError[] = [];
  for (const file of workflowFiles(root).sort()) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    try {
      const workflow = parseWorkflow(file, root, registry);
      if (workflow.disabled) continue;
      const validation = registry ? validateWorkflow(workflow, registry) : [];
      if (validation.length) errors.push({ path: relative, errors: validation });
      else workflows.push(workflow);
    } catch (error) {
      errors.push({ path: relative, errors: [error instanceof Error ? error.message : String(error)] });
    }
  }
  if (registry) for (const [name, provider] of registry.workflowDiscoveries) {
    try {
      const discovered = provider.discover(workflows);
      errors.push(...discovered.errors);
      for (const workflow of discovered.workflows) {
        if (workflow.disabled) continue;
        const validation = validateWorkflow(workflow, registry);
        if (workflows.some((existing) => existing.id === workflow.id)) validation.push(`Duplicate workflow identity: ${workflow.id}`);
        if (validation.length) errors.push({ path: workflow.path, errors: validation });
        else workflows.push(workflow);
      }
    } catch (error) {
      errors.push({ path: name, errors: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return { workflows, errors };
}

export function resolveWorkflow(workflows: readonly Workflow[], identifier: string): Workflow | undefined {
  const normalized = identifier.replace(/^\.\//, "");
  const exact = workflows.find((workflow) => workflow.id === normalized);
  if (exact) return exact;
  const matches = workflows.filter((workflow) => workflow.id.replace(/\.(md|yaml|yml)$/, "") === normalized);
  if (matches.length > 1) throw new Error(`Ambiguous workflow '${identifier}'; specify one of: ${matches.map((workflow) => workflow.id).join(", ")}`);
  return matches[0];
}
