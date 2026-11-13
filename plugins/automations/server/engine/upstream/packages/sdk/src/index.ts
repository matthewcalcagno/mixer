import type { ZodType } from "zod";
import { z } from "zod";
export { z } from "zod";

export type MaybePromise<T> = T | Promise<T>;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface OperationContext {
  signal: AbortSignal;
  /** ISO 8601 instant after which the operation should no longer begin new work. */
  deadline?: string;
  /** Candidate workflow being evaluated, when matching a subscription. */
  workflowId?: string;
  /** Immutable candidate definition, for extension-owned eligibility policies. */
  workflow?: Workflow;
  /** Ephemeral evaluation batch identity. Sources may share read-only fetches within this batch. */
  batchId?: string;
}

export interface Event {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  repository?: string;
  actor?: { id?: string; name?: string };
  data: unknown;
  /** Explicit caller input for an event-inheriting child; never activation authority. */
  input?: unknown;
  provenance?:
    | {
        kind: "replay";
        sourceRunId: string;
        rootRunId: string;
        sourceEventId: string;
      }
    | {
        kind: "reroute";
        sourceEventId: string;
      }
    | {
        kind: "handoff";
        parentRunId: string;
        rootRunId: string;
        sourceEventId: string;
      };
}

export interface WorkflowSubscription {
  readonly type: string;
  readonly config: unknown;
  readonly workflowId: string;
  readonly repository?: string;
}

export interface EventSourceContext {
  type: string;
  signal: AbortSignal;
  subscriptions: readonly WorkflowSubscription[];
  /** ISO 8601 instant at which the source operation is expected to stop. */
  deadline?: string;
  emit(event: Event): Promise<boolean | EventEmitResult>;
  /** Wake deferred routes owned by this source for an integration-defined resource. */
  reconcile?(resourceKey: string): void;
  reportHealth?(health: EventSourceHealth): void;
}

export type EventEmitStatus = "accepted" | "duplicate" | "rejected";

export interface EventEmitResult {
  version: 1;
  eventId: string;
  status: EventEmitStatus;
  /** Stable machine-readable explanation, primarily for rejected events. */
  reason?: string;
  runIds?: readonly string[];
}

export type EventSourceHealthStatus = "starting" | "ready" | "degraded" | "unhealthy" | "stopped";

export interface EventSourceHealth {
  version: 1;
  status: EventSourceHealthStatus;
  observedAt: string;
  /** Latest operation result, independent of persistent readiness warnings. Omit for status-based accounting. */
  result?: "success" | "failure";
  reason?: string;
  details?: JsonValue;
}

export interface WorkspaceSource {
  repository: string;
  revision: string;
}

export interface EventActivation {
  /** An authoritative source check can skip obsolete work without starting an executor. */
  decision?: { kind: "skip"; reason: string };
  /** Immutable, source-owned facts fetched immediately before a run starts. */
  data?: JsonValue;
  workspaceSource?: WorkspaceSource;
}

export const eventMatchSchema = z.union([
  z.boolean(),
  z.object({ kind: z.literal("ignore"), reason: z.string().min(1).max(500) }).strict(),
  z.object({
    kind: z.literal("defer"),
    resourceKey: z.string().min(1),
    reason: z.string().min(1),
    retryAfter: z.number().int().min(1_000).max(86_400_000),
    expiresAfter: z.number().int().min(1_000).max(30 * 86_400_000),
  }).strict(),
]);
/** true runs now, false/ignore skips the event, defer waits for resource eligibility. */
export type EventMatch = z.infer<typeof eventMatchSchema>;

export interface EventSource {
  /** Opaque exclusive execution resource, shared across workflows owned by this source. */
  resourceKey?(event: Event): string | undefined;
  configSchema?: ZodType;
  start(context: EventSourceContext): MaybePromise<void>;
  updateSubscriptions?(type: string, subscriptions: readonly WorkflowSubscription[]): MaybePromise<void>;
  stop?(): MaybePromise<void>;
  match?(event: Event, config: unknown, operation?: OperationContext): MaybePromise<EventMatch>;
  activate?(event: Event, operation?: OperationContext): MaybePromise<EventActivation>;
  health?(operation?: OperationContext): MaybePromise<EventSourceHealth>;
}

export interface EventRegistry {
  registerSource(type: string, source: EventSource): void;
}

/** External producers cannot supply source identity, provenance, or activation authority. */
export const eventCandidateSchema = z.object({
  id: z.string().min(1).max(1024), type: z.string().min(1).max(200),
  timestamp: z.iso.datetime(), repository: z.string().min(1).max(500).optional(),
  actor: z.object({ id: z.string().optional(), name: z.string().optional() }).strict().optional(),
  data: z.json(),
}).strict();
export type EventCandidate = z.infer<typeof eventCandidateSchema>;

export type InputResult =
  | { kind: "event"; result: EventEmitResult }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "response"; status: number; body: string; contentType?: string };

export interface InputHandler {
  configSchema: ZodType;
  /** Each type must be registered by the same extension as this handler. */
  eventTypes: readonly string[];
  receive(input: unknown, config: unknown, context: OperationContext & {
    emit(event: EventCandidate): Promise<EventEmitResult>;
  }): MaybePromise<InputResult>;
}

export interface InputRegistry {
  register(name: string, handler: InputHandler): void;
  validate(name: string, config: unknown): void;
  submit(name: string, input: unknown, config: unknown, operation?: OperationContext): Promise<InputResult>;
}

/** Raw HTTP bytes and normalized headers. Only local daemon submission sets local=true. */
export const webhookRequestSchema = z.object({
  endpoint: z.string().min(1), body: z.instanceof(Uint8Array),
  headers: z.record(z.string(), z.string()), local: z.boolean(),
}).strict();
export type WebhookRequest = z.infer<typeof webhookRequestSchema>;

export interface WorkflowFieldDefinition {
  schema: ZodType;
  description?: string;
}

export interface WorkflowRegistry {
  /** Register one extension-owned top-level workflow frontmatter field. Use a namespaced name. */
  registerField(name: string, definition: WorkflowFieldDefinition): void;
  /** Register an extension-owned scripted workflow executor. */
  registerRunner(name: string, definition: WorkflowRunnerDefinition): void;
  /** Discover extension-owned definitions as ordinary supervised workflows. */
  registerDiscovery(name: string, provider: WorkflowDiscoveryProvider): void;
}

export interface WorkflowError {
  path: string;
  errors: string[];
}

export interface WorkflowDiscovery {
  workflows: Workflow[];
  errors: WorkflowError[];
}

export interface WorkflowDiscoveryProvider {
  /** Additional definition directories watched by the daemon. */
  watchPaths: readonly string[];
  discover(knownWorkflows: readonly Workflow[]): WorkflowDiscovery;
}

export type StepStatus = StepRecord["status"];

export const stepRecordSchema = z.object({
  id: z.string(), ordinal: z.number().int().nonnegative(), name: z.string(), attempt: z.number().int().nonnegative(),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped", "cancelled", "interrupted"]),
  startedAt: z.string().optional(), finishedAt: z.string().optional(), exitCode: z.number().int().optional(),
  error: z.string().optional(), tolerated: z.boolean().optional(),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;

export interface WorkflowRunnerContext {
  run: Run;
  event: Event;
  workflow: Workflow;
  configuration: unknown;
  workspace: Workspace;
  execution: ProcessAPI;
  signal: AbortSignal;
  deadline: string;
  noOutputTimeout: number;
  logger: Logger;
  cli?: { command: string; args: readonly string[] };
  /** Lease-fenced persistence. Throws when this worker no longer owns the run. */
  recordStep(record: StepRecord): void;
  /** Core-owned context for scoped queries, idempotent child submission, and Safe Action requests. */
  stepEnvironment(id: string): Record<string, string>;
  /** Distinguish user cancellation, deadline failure, and daemon interruption. */
  abortStatus(): "cancelled" | "failed" | "interrupted";
}

export interface WorkflowRunnerDefinition {
  schema: ZodType;
  run(context: WorkflowRunnerContext): MaybePromise<WorkflowRunnerResult>;
}

/** Trusted executor result, never an agent-return protocol or action proposal. */
export interface WorkflowRunnerResult {
  version: 1;
  outcome: AgentOutcome;
  reason?: string;
}

export interface SafeActionPolicy {
  max: number;
  [key: string]: unknown;
}

export interface SafeActionContext {
  run: Run;
  event: Event;
  repository?: string;
  workspace?: Workspace;
  policy: SafeActionPolicy;
  logger: Logger;
  artifact?: WorkspaceArtifact;
  verification?: readonly VerificationResult[];
  /** Core-validated maintainer communication produced by the operator role. */
  communication?: MaintainerCommunication;
  signal?: AbortSignal;
  /** ISO 8601 instant after which the operation should no longer begin external mutations. */
  deadline?: string;
  /** Present when applying or reconciling a persisted action effect. */
  operation?: SafeActionOperationContext;
}

export interface SafeActionOperationContext {
  version: 1;
  actionId: string;
  planId?: string;
  effectId?: string;
  idempotencyKey: string;
  attempt: number;
  reconciliation: boolean;
}

export interface SafeActionPrepareContext extends SafeActionContext {
  activation?: EventActivation;
  /** Immutable workflow snapshot, including the execution kind and declared policies. */
  workflow?: Workflow;
}

export interface SafeActionDefinition<Input = unknown, Policy extends SafeActionPolicy = SafeActionPolicy> {
  description?: string;
  schema: ZodType<Input>;
  policySchema?: ZodType<Policy>;
  execute?(context: SafeActionContext, input: Input): MaybePromise<unknown>;
  /** Safe Actions are proposal-only while a workflow is executing. */
  prepare(context: SafeActionPrepareContext, input: Input): MaybePromise<unknown>;
  executePrepared(context: SafeActionContext, prepared: unknown): MaybePromise<unknown>;
}

export interface SafeActionRegistry {
  register<Input, Policy extends SafeActionPolicy = SafeActionPolicy>(
    name: string,
    definition: SafeActionDefinition<Input, Policy>,
  ): void;
}

export interface SafeActionTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  request(input: unknown): Promise<SafeActionResult>;
}

export type AgentRole = "planner" | "implementer" | "reviewer" | "operator";

export type MaintainerMessagePurpose = "reply" | "review" | "change" | "report" | "status";
export type MaintainerReferenceSource = "event" | "repository" | "workspace" | "verification" | "run";

export interface MaintainerReference {
  source: MaintainerReferenceSource;
  value: string;
}

export interface MaintainerMessage {
  purpose: MaintainerMessagePurpose;
  /** A short subject for change proposals. Omit it for comments and reviews. */
  subject?: string;
  body: string;
  /** Machine-checkable references to authoritative run context. */
  references: MaintainerReference[];
}

export interface MaintainerCommunication {
  version: 1;
  language: string;
  messages: MaintainerMessage[];
}

export function requireMaintainerMessage(
  communication: MaintainerCommunication | undefined,
  purpose: MaintainerMessagePurpose,
): MaintainerMessage {
  const message = communication?.messages.find((item) => item.purpose === purpose);
  if (!message) throw new Error(`communication_message_missing:${purpose}`);
  return message;
}

export interface CommunicationPolicy {
  /** Human language requested for public-facing communication. */
  language: string;
  /** Fixed core style identifier. Extensions must not reinterpret its semantics. */
  style: "maintainer-direct";
}

export interface AgentHandoff {
  id: string;
  runId: string;
  role: AgentRole;
  ordinal: number;
  payload: JsonValue;
  hash: string;
  createdAt: string;
}

export interface AgentContext {
  run: Run;
  event: Event;
  repository?: string;
  workspace?: Workspace;
  /** Effective workspace permission requested from the harness. */
  workspaceAccess?: "read-only" | "read-write";
  /** True when core will discard direct edits and apply only typed file proposals. */
  proposalOnly?: boolean;
  /** Core-collected changed-file manifest, when a workspace was implemented. */
  artifact?: WorkspaceArtifact;
  /** Deterministic command results collected outside the agent role. */
  verification?: readonly VerificationResult[];
  instructions: string[];
  prompt: string;
  actions: readonly SafeActionTool[];
  execution: ProcessAPI;
  signal: AbortSignal;
  logger: Logger;
  /** The deterministic role being executed by the core run protocol. */
  role?: AgentRole;
  /** Optional model selected by the workflow. */
  model?: string;
  /** Optional harness-specific thinking or reasoning mode selected by the workflow. */
  thinking?: string;
  profile?: string;
  timeout?: number;
  /** ISO 8601 instant for the overall provider invocation, when known. */
  deadline?: string;
  /** Abort an unattended harness that stops producing output. */
  noOutputTimeout?: number;
  /** Validated outputs from earlier protocol stages. */
  handoffs?: readonly AgentHandoff[];
  /** JSON Schema for the required MIXER_AUTOMATIONS_HANDOFF payload, when applicable. */
  outputSchema?: Record<string, unknown>;
  /** Core-owned public communication contract shared by all integrations. */
  communication?: CommunicationPolicy;
}

export type AgentOutcome = "acted" | "no-op" | "blocked" | "failed" | "unknown";

export interface AgentActionEvidence {
  name: string;
  reference?: string;
  /** Serialized input for an explicitly workflow-authorized Safe Action. */
  input?: JsonValue;
}

export interface AgentResult {
  version: 1;
  outcome: AgentOutcome;
  output?: string;
  metadata?: JsonValue;
  reason?: string;
  actions?: readonly AgentActionEvidence[];
  verification?: readonly string[];
  unresolved?: readonly string[];
  references?: readonly string[];
}

/** @deprecated Return AgentResult for deterministic outcome handling. */
export interface LegacyAgentResult {
  output?: string;
  metadata?: JsonValue;
}

export interface AgentProvider {
  run(context: AgentContext): MaybePromise<AgentResult | LegacyAgentResult | void>;
}

/** Agent harness extensions implement this provider contract. */
export type AgentHarnessProvider = AgentProvider;
export type AgentHarnessContext = AgentContext;

export interface AgentRegistry {
  register(name: string, provider: AgentProvider): void;
}

export interface Workspace {
  path: string;
  metadata?: JsonValue;
  /** Trusted environment entries applied to every harness process in this workspace. */
  environment?: Record<string, string>;
}

export interface WorkspaceContext {
  run: Run;
  repository?: string;
  signal: AbortSignal;
  /** ISO 8601 instant for this workspace operation, when bounded. */
  deadline?: string;
  logger: Logger;
  source?: WorkspaceSource;
}

export interface WorkspaceArtifactFile {
  path: string;
  operation: "add" | "update" | "delete";
  mode: string;
  size: number;
  sha256?: string;
  content?: string;
}

export interface WorkspaceArtifact {
  version: 1;
  baseRevision?: string;
  files: readonly WorkspaceArtifactFile[];
  hash: string;
}

export interface WorkspaceAttestation {
  version: 1;
  /** Workspace shape. Omitted by legacy providers and treated as git. */
  kind?: "git" | "directory";
  /** Canonical checkout root actually inspected by the workspace provider. */
  path: string;
  repository?: string;
  revision: string;
  branch?: string;
  remote?: string;
  clean: boolean;
  verifiedAt: string;
}

export interface EffectiveWorkspace {
  initial: WorkspaceAttestation;
  final?: WorkspaceAttestation;
}

export interface WorkspaceProvider {
  create(context: WorkspaceContext): MaybePromise<Workspace>;
  /** Inspect the actual checkout. Core requires this before starting a harness. */
  attest(context: WorkspaceContext, workspace: Workspace): MaybePromise<WorkspaceAttestation>;
  /** Recreate a clean workspace at its original trusted source before core applies a proposal. */
  reset?(context: WorkspaceContext, workspace: Workspace): MaybePromise<Workspace>;
  collect?(context: WorkspaceContext, workspace: Workspace): MaybePromise<WorkspaceArtifact>;
  cleanup?(context: WorkspaceContext, workspace: Workspace): MaybePromise<void>;
}

export interface WorkspaceRegistry {
  register(name: string, provider: WorkspaceProvider): void;
}

export type ExecutionIsolation = "isolated" | "proposal-only" | "none";

export interface ExecutionContext {
  run: Run;
  workflow: Workflow;
  workspace?: Workspace;
  signal: AbortSignal;
  /** ISO 8601 instant for this execution operation, when bounded. */
  deadline?: string;
  logger: Logger;
  stage?: "agent" | "steps" | "verification" | AgentRole;
  role?: AgentRole;
  /** Provider selected for this role; useful to execution providers choosing an image. */
  agent?: string;
  /** Workspace access requested for this process. */
  workspaceAccess?: "read-only" | "read-write";
}

export interface ExecutionSession {
  process: ProcessAPI;
  close(): MaybePromise<void>;
}

export interface ExecutionProvider {
  isolation: ExecutionIsolation;
  validate?(workflow: Workflow): readonly string[];
  open(context: ExecutionContext): MaybePromise<ExecutionSession>;
}

export interface ExecutionRegistry {
  register(name: string, provider: ExecutionProvider): void;
}

export type HookName =
  | "event:received"
  | "workflow:matched"
  | "run:created"
  | "run:acquire"
  | "run:before"
  | "run:after"
  | "run:finalized"
  | "execution:before"
  | "agent:before"
  | "agent:after"
  | "safe-action:before"
  | "safe-action:after";

export interface HookContext {
  signal?: AbortSignal;
  deadline?: string;
  event?: Event;
  workflow?: Workflow;
  run?: Run;
  workspace?: Workspace;
  role?: AgentRole;
  instructions: string[];
  metadata: Record<string, unknown>;
  cancelled?: boolean;
  reason?: string;
}

export interface HookRegistry {
  on(name: HookName, handler: (context: HookContext) => MaybePromise<void>): void;
}

export interface ExtensionCommand {
  name: string;
  description: string;
  run(args: readonly string[]): MaybePromise<void>;
  /** Optional read-only query usable by a scripted step without forwarding integration credentials. */
  query?(args: readonly string[], context: { run: Run; event: Event; workflow: Workflow; signal: AbortSignal; deadline: string }): MaybePromise<JsonValue>;
}

export interface CommandRegistry {
  register(command: ExtensionCommand): void;
}

export interface ExtensionConfigAPI {
  get(): unknown;
  /** Effective global run-history retention, without exposing other extension settings. */
  historyRetentionMs(): number;
}

export interface ExtensionState {
  get<T extends JsonValue>(key: string): T | undefined;
  set<T extends JsonValue>(key: string, value: T): void;
  delete(key: string): void;
  /** Enumerate this extension namespace, optionally restricted to a key prefix. */
  entries(prefix?: string): Array<{ key: string; value: JsonValue }>;
}

export interface ExtensionStateAPI {
  namespace(name?: string): ExtensionState;
}

export interface ProcessRunOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  inheritEnv?: readonly string[];
  denyEnv?: readonly string[];
  signal?: AbortSignal;
  timeout?: number;
  noOutputTimeout?: number;
  /** Stream output without retaining an unbounded in-memory copy. Defaults to true. */
  captureOutput?: boolean;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Spawn-level failure code such as ENOENT. Command exit failures leave this unset. */
  errorCode?: string;
}

export interface ProcessAPI {
  run(options: ProcessRunOptions): Promise<ProcessResult>;
}

export interface Logger {
  debug(data: unknown, message?: string): void;
  info(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface PathsAPI {
  home: string;
  config: string;
  cases: string;
  workflows: string;
  extensions: string;
  state: string;
  logs: string;
  workspaces: string;
}

export interface MixerAutomationsAPI {
  events: EventRegistry;
  inputs: InputRegistry;
  workflows: WorkflowRegistry;
  actions: SafeActionRegistry;
  agents: AgentRegistry;
  workspaces: WorkspaceRegistry;
  executions: ExecutionRegistry;
  hooks: HookRegistry;
  commands: CommandRegistry;
  config: ExtensionConfigAPI;
  state: ExtensionStateAPI;
  process: ProcessAPI;
  logger: Logger;
  paths: PathsAPI;
}

export interface ExtensionStartContext {
  signal: AbortSignal;
  logger: Logger;
}

export interface Extension {
  name: string;
  version?: string;
  setup(api: MixerAutomationsAPI): MaybePromise<void>;
  start?(context: ExtensionStartContext): MaybePromise<void>;
  stop?(): MaybePromise<void>;
}

export function defineExtension<const T extends Extension>(extension: T): T {
  return extension;
}

export interface Workflow {
  id: string;
  path: string;
  name: string;
  repository?: string | readonly string[];
  /** Excluded from active discovery when true. Omission means enabled. */
  disabled?: boolean;
  on: Record<string, unknown>;
  /** Validated values for extension-owned top-level frontmatter fields. */
  extensions?: Record<string, unknown>;
  agent: string;
  model?: string;
  thinking?: string;
  timeout?: number;
  execution: string;
  workspace?: string;
  safeActions: Record<string, SafeActionPolicy>;
  prompt: string;
  /** Omitted for historical and current Markdown agent workflows. */
  task?: { kind: "steps"; runner: string; configuration: unknown };
  verification?: readonly VerificationCommand[];
}

export interface VerificationCommand {
  command: string;
  args: readonly string[];
  timeoutMs: number;
}

export interface VerificationResult {
  command: string;
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface Run {
  id: string;
  workflowId: string;
  repository?: string;
  resourceKey?: string;
  event: Event;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  activation?: EventActivation;
}

export type SafeActionStatus = "requested" | "proposed" | "validated" | "rejected" | "executed" | "failed" | "staged";

export interface SafeActionResult {
  id: string;
  status: SafeActionStatus;
  reason?: string;
  result?: unknown;
}
