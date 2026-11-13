import Database from "better-sqlite3";
import path from "node:path";
import type { AgentHandoff, EffectiveWorkspace, Event, EventActivation, JsonValue, Run, RunStatus, SafeActionStatus, VerificationResult, Workflow, WorkspaceArtifact } from "@mixer/automations-sdk";
import { stepRecordSchema, z, type StepRecord } from "@mixer/automations-sdk";

export interface SafeActionRecord {
  id: string;
  runId: string;
  action: string;
  payload: unknown;
  status: SafeActionStatus;
  reason?: string;
  createdAt: string;
  executedAt?: string;
  result?: unknown;
}

export interface ActionPlanRecord {
  id: string;
  runId: string;
  plan: unknown;
  hash: string;
  status: "validated" | "applying" | "completed" | "failed" | "staged";
  reason?: string;
  createdAt: string;
}

export interface ActionEffectRecord {
  id: string;
  planId: string;
  ordinal: number;
  idempotencyKey: string;
  prepared: unknown;
  status: "pending" | "executing" | "executed" | "failed";
  attempts: number;
  result?: unknown;
  error?: string;
}

export interface ReplayRecord {
  id: string;
  sourceRunId: string;
  rootRunId: string;
  runId: string;
  eventId: string;
  workflowMode: "snapshot" | "current";
  workflowHash: string;
  createdAt: string;
}

export interface RerouteRecord {
  id: string;
  sourceEventId: string;
  eventId: string;
  createdAt: string;
}

const deferredRouteSchema = z.object({
  workflowId: z.string(), eventId: z.string(), source: z.string(), resourceKey: z.string(),
  workflowHash: z.string(), reason: z.string(), availableAt: z.number(), expiresAt: z.number(),
});
export type DeferredRouteRecord = z.infer<typeof deferredRouteSchema>;

const eventDecisionSchema = z.object({
  eventId: z.string(), workflowId: z.string(), decision: z.enum(["ignored", "deferred", "queued"]), reason: z.string(),
});
export type EventDecision = z.infer<typeof eventDecisionSchema>;

export interface RunLease {
  runId: string;
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface RunAdmissionRecord {
  run: Run;
  agent: string;
  execution: string;
  workspace?: string;
  metadata?: { workflow?: unknown; workflowHash?: string; activation?: EventActivation };
  availableAt?: number;
  deadline?: number;
}

export type AdmissionResult =
  | { admitted: true; runs: Run[] }
  | { admitted: false; reason: "duplicate_event" | "duplicate_reroute" | "capacity" };

export interface LifecycleOutboxRecord {
  id: string;
  runId: string;
  event: string;
  payload: unknown;
  status: "pending" | "delivering" | "delivered";
  availableAt: number;
  attempts: number;
  leaseGeneration: number;
  createdAt: string;
  deliveredAt?: string;
  error?: string;
}

export interface SourceHealthRecord {
  source: string;
  status: "healthy" | "degraded" | "unavailable";
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  nextAttemptAt?: number;
  error?: string;
  updatedAt: string;
}

export type StoredRun = Run & {
  agent: string;
  execution?: string;
  workspace?: string;
  effectiveWorkspace?: EffectiveWorkspace;
  error?: string;
  phase?: string;
  workflowHash?: string;
  sourceRevision?: string;
  planHash?: string;
  verification?: VerificationResult[];
  attempts: number;
  availableAt?: number;
  deadline?: number;
  cancellation?: { requestedAt: string; reason?: string };
  outcome?: unknown;
  leaseGeneration: number;
};

function addColumn(database: Database.Database, table: string, column: string, definition: string): void {
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const migrations: Array<(database: Database.Database) => void> = [
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL,
        timestamp TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, repository TEXT,
        event_id TEXT NOT NULL, event_json TEXT NOT NULL, agent TEXT NOT NULL,
        workspace TEXT, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_routes (
        workflow_id TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(workflow_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS replay_requests (
        id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL, root_run_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
        workflow_mode TEXT NOT NULL, workflow_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS safe_actions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, action TEXT NOT NULL,
        payload TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at TEXT NOT NULL, executed_at TEXT, result TEXT
      );
      CREATE INDEX IF NOT EXISTS safe_actions_run_action ON safe_actions(run_id, action);
      CREATE TABLE IF NOT EXISTS extension_state (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL,
        manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_plans (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, plan_json TEXT NOT NULL,
        plan_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, reason TEXT,
        created_at TEXT NOT NULL, applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS action_effects (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, prepared_json TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT, error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_deliveries (
        delivery_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_handoffs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_handoffs_run ON agent_handoffs(run_id, ordinal);
    `);
    addColumn(database, "runs", "execution", "TEXT");
    addColumn(database, "runs", "phase", "TEXT");
    addColumn(database, "runs", "activation_json", "TEXT");
    addColumn(database, "runs", "workflow_json", "TEXT");
    addColumn(database, "runs", "workflow_hash", "TEXT");
    addColumn(database, "runs", "source_repository", "TEXT");
    addColumn(database, "runs", "source_revision", "TEXT");
    addColumn(database, "runs", "verification_json", "TEXT");
    addColumn(database, "runs", "plan_hash", "TEXT");
    addColumn(database, "runs", "effective_workspace_json", "TEXT");
    addColumn(database, "runs", "lease_owner", "TEXT");
    addColumn(database, "runs", "lease_expires_at", "INTEGER");
    addColumn(database, "runs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    database.exec(`INSERT OR IGNORE INTO run_routes(workflow_id, event_id, run_id)
      SELECT workflow_id, event_id, id FROM runs ORDER BY created_at, id`);
  },
  (database) => {
    addColumn(database, "runs", "lease_generation", "INTEGER NOT NULL DEFAULT 0");
    addColumn(database, "runs", "available_at", "INTEGER");
    addColumn(database, "runs", "deadline", "INTEGER");
    addColumn(database, "runs", "cancel_requested_at", "TEXT");
    addColumn(database, "runs", "cancel_reason", "TEXT");
    addColumn(database, "runs", "outcome_json", "TEXT");
    database.exec(`
      CREATE INDEX IF NOT EXISTS runs_claimable ON runs(status, available_at, created_at);
      CREATE TABLE IF NOT EXISTS lifecycle_outbox (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', available_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER,
        created_at TEXT NOT NULL, delivered_at TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS lifecycle_outbox_pending ON lifecycle_outbox(status, available_at, created_at);
      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY, status TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT, last_failure_at TEXT, next_attempt_at INTEGER, error TEXT, updated_at TEXT NOT NULL
      );
    `);
  },
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS reroute_requests (
        id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
    `);
  },
  (database) => {
    // Older versions assigned deadlines at admission. Runs never claimed by a
    // worker have not started their execution window yet.
    database.exec("UPDATE runs SET deadline = NULL WHERE status = 'queued' AND attempts = 0");
  },
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt INTEGER NOT NULL, ordinal INTEGER NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(run_id, step_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS child_requests (
        parent_run_id TEXT NOT NULL, step_id TEXT NOT NULL, handoff_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        PRIMARY KEY(parent_run_id, step_id, handoff_key)
      );
    `);
  },
  (database) => {
    database.exec(`CREATE TABLE IF NOT EXISTS scripted_action_requests (
      run_id TEXT NOT NULL, step_id TEXT NOT NULL, request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE, step_attempt INTEGER NOT NULL,
      PRIMARY KEY(run_id, step_id, request_key)
    )`);
  },
  (database) => {
    database.exec(`CREATE TABLE IF NOT EXISTS deferred_routes (
      workflow_id TEXT NOT NULL, event_id TEXT NOT NULL, source TEXT NOT NULL,
      resource_key TEXT NOT NULL, workflow_hash TEXT NOT NULL, reason TEXT NOT NULL,
      available_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(workflow_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS deferred_routes_due ON deferred_routes(available_at);
    CREATE INDEX IF NOT EXISTS deferred_routes_resource ON deferred_routes(source, resource_key);`);
  },
  (database) => {
    addColumn(database, "runs", "resource_key", "TEXT");
    addColumn(database, "runs", "eligibility_resource", "TEXT");
    database.exec("CREATE INDEX IF NOT EXISTS runs_resource ON runs(resource_key, status, lease_expires_at)");
    database.exec(`CREATE TABLE IF NOT EXISTS event_decisions (
      event_id TEXT NOT NULL, workflow_id TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY(event_id, workflow_id))`);
  },
];

export class StateDatabase {
  readonly db: Database.Database;

  constructor(stateDirectory: string, options: { readonly?: boolean } = {}) {
    this.db = new Database(path.join(stateDirectory, "roboplane.db"), options.readonly ? { readonly: true, fileMustExist: true } : {});
    if (options.readonly) {
      if (this.db.pragma("user_version", { simple: true }) !== migrations.length) {
        this.db.close();
        throw new Error("State database schema is out of date. Start Mixer Automations to migrate it before checking status.");
      }
      return;
    }
    this.db.pragma("journal_mode = WAL");
    const migrate = this.db.transaction(() => {
      let version = this.db.pragma("user_version", { simple: true }) as number;
      while (version < migrations.length) {
        migrations[version]!(this.db);
        version++;
        this.db.pragma(`user_version = ${version}`);
      }
    });
    migrate();
  }

  close(): void { this.db.close(); }

  isLeaseCurrent(lease: RunLease): boolean {
    return !!this.db.prepare("SELECT 1 FROM runs WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ? AND deadline > ?")
      .get(lease.runId, lease.owner, lease.generation, Date.now(), Date.now());
  }

  recordStepFenced(lease: RunLease, record: StepRecord): void {
    const changed = this.db.prepare(`INSERT INTO run_steps(run_id, step_id, attempt, ordinal, record_json)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND lease_owner = ?
        AND lease_generation = ? AND lease_expires_at >= ?)
      ON CONFLICT(run_id, step_id, attempt) DO UPDATE SET record_json = excluded.record_json`)
      .run(lease.runId, record.id, record.attempt, record.ordinal, JSON.stringify(record), lease.runId, lease.owner, lease.generation, Date.now()).changes;
    if (!changed) throw new Error("run_lease_lost");
    if (record.attempt > 0) this.db.prepare("DELETE FROM run_steps WHERE run_id = ? AND step_id = ? AND attempt = 0").run(lease.runId, record.id);
  }

  listSteps(runId: string): StepRecord[] {
    const rows = this.db.prepare("SELECT record_json FROM run_steps WHERE run_id = ? ORDER BY ordinal, attempt").all(runId);
    return rows.map((row) => {
      if (!row || typeof row !== "object" || !("record_json" in row) || typeof row.record_json !== "string") throw new Error("Invalid persisted step");
      return stepRecordSchema.parse(JSON.parse(row.record_json));
    });
  }

  childRequest(parentRunId: string, stepId: string, key: string): { runId: string; hash: string } | undefined {
    const row = this.db.prepare("SELECT run_id, request_hash FROM child_requests WHERE parent_run_id = ? AND step_id = ? AND handoff_key = ?").get(parentRunId, stepId, key);
    if (!row) return undefined;
    if (typeof row !== "object" || !("run_id" in row) || !("request_hash" in row) || typeof row.run_id !== "string" || typeof row.request_hash !== "string") throw new Error("Invalid child request");
    return { runId: row.run_id, hash: row.request_hash };
  }

  childRuns(parentRunId: string): string[] {
    return this.db.prepare("SELECT run_id FROM child_requests WHERE parent_run_id = ? ORDER BY created_at, run_id").all(parentRunId)
      .flatMap((row) => row && typeof row === "object" && "run_id" in row && typeof row.run_id === "string" ? [row.run_id] : []);
  }

  parentRun(runId: string): string | undefined {
    const row = this.db.prepare("SELECT parent_run_id FROM child_requests WHERE run_id = ?").get(runId);
    return row && typeof row === "object" && "parent_run_id" in row && typeof row.parent_run_id === "string" ? row.parent_run_id : undefined;
  }

  admitChild(lease: RunLease, stepId: string, key: string, hash: string, event: Event, record: RunAdmissionRecord, maxQueuedRuns: number, stepAttempt: number): Run {
    return this.db.transaction(() => {
      const parent = this.db.prepare(`SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
        AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ? AND deadline > ?`)
        .get(lease.runId, lease.owner, lease.generation, Date.now(), Date.now());
      if (!parent) throw new Error("handoff_parent_unavailable");
      const step = this.listSteps(lease.runId).filter((item) => item.id === stepId).at(-1);
      if (step?.status !== "running" || step.attempt !== stepAttempt) throw new Error("handoff_step_not_running");
      const existing = this.childRequest(lease.runId, stepId, key);
      if (existing) {
        if (existing.hash !== hash) throw new Error("handoff_key_conflict");
        const run = this.getRun(existing.runId);
        if (!run) throw new Error("handoff_child_expired");
        return run;
      }
      const result = this.admitEventWithRuns(event, [record], maxQueuedRuns);
      if (!result.admitted) throw new Error(result.reason);
      this.db.prepare("INSERT INTO child_requests VALUES (?, ?, ?, ?, ?, ?)")
        .run(lease.runId, stepId, key, hash, record.run.id, new Date().toISOString());
      return record.run;
    }).immediate();
  }

  insertEvent(event: Event): boolean {
    return this.db.prepare(
      "INSERT OR IGNORE INTO events(id, type, source, timestamp, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(event.id, event.type, event.source, event.timestamp, JSON.stringify(event)).changes === 1;
  }

  hasEvent(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE id = ?").get(id) !== undefined;
  }

  getEvent(id: string): Event | undefined {
    const row = this.db.prepare("SELECT payload FROM events WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Event : undefined;
  }

  eventHasRuns(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM run_routes WHERE event_id = ? LIMIT 1").get(eventId) !== undefined;
  }

  eventHasDeferredRoutes(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM deferred_routes WHERE event_id = ? LIMIT 1").get(eventId) !== undefined;
  }

  insertRun(run: Run, agent: string, execution: string, workspace?: string, metadata?: {
    workflow?: unknown; workflowHash?: string; activation?: EventActivation;
  }): boolean {
    const insert = this.db.transaction(() => this.insertRunStatement(run, agent, execution, workspace, metadata) === 1);
    return insert();
  }

  private insertRunStatement(run: Run, agent: string, execution: string, workspace?: string, metadata?: {
    workflow?: unknown; workflowHash?: string; activation?: EventActivation;
  }, scheduling?: { availableAt?: number; deadline?: number }): number {
    const claimed = this.db.prepare("INSERT OR IGNORE INTO run_routes(workflow_id, event_id, run_id) VALUES (?, ?, ?)")
      .run(run.workflowId, run.event.id, run.id).changes;
    if (!claimed) return 0;
    return this.db.prepare(`INSERT INTO runs
      (id, workflow_id, repository, event_id, event_json, agent, execution, workspace, status, created_at, updated_at,
        phase, activation_json, workflow_json, workflow_hash, source_repository, source_revision, available_at, deadline, resource_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.workflowId, run.repository ?? null, run.event.id, JSON.stringify(run.event), agent,
        execution, workspace ?? null, run.status, run.createdAt, run.updatedAt, "queued",
        metadata?.activation ? JSON.stringify(metadata.activation) : null,
         metadata?.workflow === undefined ? null : JSON.stringify(metadata.workflow), metadata?.workflowHash ?? null,
         metadata?.activation?.workspaceSource?.repository ?? null,
         metadata?.activation?.workspaceSource?.revision ?? null,
         scheduling?.availableAt ?? null, scheduling?.deadline ?? null, run.resourceKey ?? null).changes;
  }

  insertEventWithRuns(event: Event, records: Array<{
    run: Run; agent: string; execution: string; workspace?: string;
    metadata?: { workflow?: unknown; workflowHash?: string; activation?: EventActivation };
  }>): Run[] | undefined {
    const route = this.db.transaction(() => {
      if (!this.insertEvent(event)) return undefined;
      return records.flatMap((record) => {
        if (this.insertRunStatement(record.run, record.agent, record.execution, record.workspace, record.metadata) !== 1) {
          throw new Error(`Run route already exists for workflow '${record.run.workflowId}' and event '${event.id}'`);
        }
        return [record.run];
      });
    });
    return route();
  }

  admitEventWithRuns(event: Event, records: readonly RunAdmissionRecord[], maxActiveRuns: number, deferred: readonly DeferredRouteRecord[] = [], decisions: readonly EventDecision[] = []): AdmissionResult {
    if (!Number.isInteger(maxActiveRuns) || maxActiveRuns < 0) throw new Error("maxActiveRuns must be a non-negative integer");
    const admit = this.db.transaction((): AdmissionResult => {
      if (this.hasEvent(event.id)) return { admitted: false, reason: "duplicate_event" };
      const active = this.db.prepare(`SELECT COUNT(*) count FROM runs
        WHERE status IN ('queued', 'preparing', 'waiting', 'running')`).get() as { count: number };
      if (active.count + records.length > maxActiveRuns) return { admitted: false, reason: "capacity" };
      if (!this.insertEvent(event)) return { admitted: false, reason: "duplicate_event" };
      for (const record of records) {
        if (this.insertRunStatement(record.run, record.agent, record.execution, record.workspace, record.metadata, record) !== 1) {
          throw new Error(`Run route already exists for workflow '${record.run.workflowId}' and event '${event.id}'`);
        }
      }
      for (const route of deferred) this.insertDeferredRoute(route);
      for (const decision of decisions) this.recordEventDecision(decision);
      return { admitted: true, runs: records.map(({ run }) => run) };
    });
    return admit.immediate();
  }

  admitReroutedEventWithRuns(
    reroute: RerouteRecord,
    event: Event,
    records: readonly RunAdmissionRecord[],
    maxActiveRuns: number,
    deferred: readonly DeferredRouteRecord[] = [],
    decisions: readonly EventDecision[] = [],
  ): AdmissionResult {
    if (!Number.isInteger(maxActiveRuns) || maxActiveRuns < 0) throw new Error("maxActiveRuns must be a non-negative integer");
    const admit = this.db.transaction((): AdmissionResult => {
      if (this.db.prepare("SELECT 1 FROM reroute_requests WHERE source_event_id = ?").get(reroute.sourceEventId)) {
        return { admitted: false, reason: "duplicate_reroute" };
      }
      if (this.hasEvent(event.id)) return { admitted: false, reason: "duplicate_event" };
      const active = this.db.prepare(`SELECT COUNT(*) count FROM runs
        WHERE status IN ('queued', 'preparing', 'waiting', 'running')`).get() as { count: number };
      if (active.count + records.length > maxActiveRuns) return { admitted: false, reason: "capacity" };
      this.db.prepare(`INSERT INTO reroute_requests(id, source_event_id, event_id, created_at)
        VALUES (?, ?, ?, ?)`).run(reroute.id, reroute.sourceEventId, reroute.eventId, reroute.createdAt);
      if (!this.insertEvent(event)) throw new Error(`Reroute event already exists: ${event.id}`);
      for (const record of records) {
        if (this.insertRunStatement(record.run, record.agent, record.execution, record.workspace, record.metadata, record) !== 1) {
          throw new Error(`Run route already exists for workflow '${record.run.workflowId}' and event '${event.id}'`);
        }
      }
      for (const route of deferred) this.insertDeferredRoute(route);
      for (const decision of decisions) this.recordEventDecision(decision);
      return { admitted: true, runs: records.map(({ run }) => run) };
    });
    return admit.immediate();
  }

  private insertDeferredRoute(route: DeferredRouteRecord): void {
    this.db.prepare(`INSERT INTO deferred_routes VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(route.workflowId, route.eventId, route.source, route.resourceKey, route.workflowHash,
        route.reason, route.availableAt, route.expiresAt);
  }

  recordEventDecision(value: EventDecision): void {
    this.db.prepare(`INSERT INTO event_decisions VALUES (?, ?, ?, ?) ON CONFLICT(event_id, workflow_id)
      DO UPDATE SET decision = excluded.decision, reason = excluded.reason`).run(value.eventId, value.workflowId, value.decision, value.reason);
  }

  explainEvent(eventId: string) {
    const event = this.getEvent(eventId);
    if (!event) throw new Error(`Event not found: ${eventId}`);
    const decisions = this.db.prepare(`SELECT event_id AS eventId, workflow_id AS workflowId, decision, reason
      FROM event_decisions WHERE event_id = ? ORDER BY workflow_id`).all(eventId).map(row => eventDecisionSchema.parse(row));
    const routes = this.db.prepare("SELECT workflow_id AS workflowId, run_id AS runId FROM run_routes WHERE event_id = ? ORDER BY workflow_id").all(eventId);
    const runs = routes.map(row => {
      const route = z.object({ workflowId: z.string(), runId: z.string() }).parse(row);
      const run = this.getRun(route.runId);
      let waitingFor: string | null = null;
      if (run?.status === "queued" && run.resourceKey) {
        const held = this.db.prepare(`SELECT h.id FROM runs h WHERE h.id != ? AND h.resource_key = ? AND (
          (h.status IN ('queued', 'preparing', 'waiting', 'running') AND h.lease_owner IS NOT NULL AND h.lease_expires_at >= ?)
          OR EXISTS (SELECT 1 FROM lifecycle_outbox l WHERE l.run_id = h.id AND l.status != 'delivered')) LIMIT 1`).get(run.id, run.resourceKey, Date.now());
        if (held) waitingFor = z.object({ id: z.string() }).parse(held).id;
      }
      return { ...route, status: run?.status ?? "history-expired", phase: run?.phase ?? null, outcome: run?.outcome ?? null,
        resourceKey: run?.resourceKey ?? null, waitingFor, availableAt: run?.availableAt ?? null };
    });
    return { event: { id: event.id, type: event.type, source: event.source, timestamp: event.timestamp, repository: event.repository ?? null },
      decisions, runs, note: decisions.length ? null : "Detailed matching decisions were not recorded for this event. No historical predicate reason is inferred." };
  }

  deferRunFenced(lease: RunLease, resourceKey: string, reason: string, availableAt: number): boolean {
    return this.db.prepare(`UPDATE runs SET status = 'queued', phase = 'waiting', error = ?, available_at = ?,
      attempts = MAX(0, attempts - 1), deadline = NULL, eligibility_resource = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ?`).run(
      reason, availableAt, resourceKey, new Date().toISOString(), lease.runId, lease.owner, lease.generation, Date.now()).changes === 1;
  }

  listDeferredRoutes(now = Date.now(), limit = 100): DeferredRouteRecord[] {
    return this.db.prepare(`SELECT workflow_id AS workflowId, event_id AS eventId, source,
      resource_key AS resourceKey, workflow_hash AS workflowHash, reason,
      available_at AS availableAt, expires_at AS expiresAt FROM deferred_routes
      WHERE available_at <= ? OR expires_at <= ? ORDER BY available_at, workflow_id, event_id LIMIT ?`)
      .all(now, now, limit).map((row) => deferredRouteSchema.parse(row));
  }

  wakeDeferredRoutes(source: string, resourceKey: string): void {
    this.db.prepare("UPDATE deferred_routes SET available_at = ? WHERE source = ? AND resource_key = ?")
      .run(Date.now(), source, resourceKey);
    this.db.prepare(`UPDATE runs SET available_at = ? WHERE status = 'queued' AND phase = 'waiting'
      AND eligibility_resource = ? AND json_extract(event_json, '$.type') = ?`).run(Date.now(), resourceKey, source);
  }

  removeDeferredRoute(route: DeferredRouteRecord): void {
    this.db.prepare("DELETE FROM deferred_routes WHERE workflow_id = ? AND event_id = ? AND workflow_hash = ?")
      .run(route.workflowId, route.eventId, route.workflowHash);
  }

  rescheduleDeferredRoute(route: DeferredRouteRecord, reason: string, availableAt: number): void {
    this.db.prepare(`UPDATE deferred_routes SET reason = ?, available_at = ?
      WHERE workflow_id = ? AND event_id = ? AND workflow_hash = ?`)
      .run(reason, availableAt, route.workflowId, route.eventId, route.workflowHash);
  }

  admitDeferredRun(route: DeferredRouteRecord, record: RunAdmissionRecord, maxActiveRuns: number): "accepted" | "obsolete" | "capacity" {
    return this.db.transaction(() => {
      const pending = this.db.prepare(`SELECT 1 FROM deferred_routes WHERE workflow_id = ? AND event_id = ?
        AND workflow_hash = ? AND expires_at > ?`).get(route.workflowId, route.eventId, route.workflowHash, Date.now());
      if (!pending) return "obsolete" as const;
      const existing = this.db.prepare("SELECT 1 FROM run_routes WHERE workflow_id = ? AND event_id = ?")
        .get(route.workflowId, route.eventId);
      if (existing) { this.removeDeferredRoute(route); return "obsolete" as const; }
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'preparing', 'waiting', 'running')").get();
      const { count } = z.object({ count: z.number() }).parse(active);
      if (count >= maxActiveRuns) return "capacity" as const;
      this.insertRunStatement(record.run, record.agent, record.execution, record.workspace, record.metadata, record);
      this.removeDeferredRoute(route);
      return "accepted" as const;
    }).immediate();
  }

  updateRun(id: string, status: RunStatus, error?: string, phase?: string): void {
    this.db.prepare("UPDATE runs SET status = ?, error = ?, phase = COALESCE(?, phase), updated_at = ? WHERE id = ?")
      .run(status, error ?? null, phase ?? null, new Date().toISOString(), id);
  }

  updateRunActivation(id: string, activation: EventActivation): void {
    this.db.prepare(`UPDATE runs SET activation_json = ?, source_repository = ?, source_revision = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(activation), activation.workspaceSource?.repository ?? null,
        activation.workspaceSource?.revision ?? null, new Date().toISOString(), id);
  }

  updateRunActivationFenced(lease: RunLease, activation: EventActivation): boolean {
    return this.db.prepare(`UPDATE runs SET activation_json = ?, source_repository = ?, source_revision = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ?`)
      .run(JSON.stringify(activation), activation.workspaceSource?.repository ?? null,
        activation.workspaceSource?.revision ?? null, new Date().toISOString(), lease.runId,
        lease.owner, lease.generation, Date.now()).changes === 1;
  }

  updateVerification(id: string, verification: readonly VerificationResult[]): void {
    this.db.prepare("UPDATE runs SET verification_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(verification), new Date().toISOString(), id);
  }

  updateEffectiveWorkspace(id: string, workspace: EffectiveWorkspace): void {
    this.db.prepare("UPDATE runs SET effective_workspace_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(workspace), new Date().toISOString(), id);
  }

  updateEffectiveWorkspaceFenced(lease: RunLease, workspace: EffectiveWorkspace): boolean {
    return this.db.prepare(`UPDATE runs SET effective_workspace_json = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ?`)
      .run(JSON.stringify(workspace), new Date().toISOString(), lease.runId,
        lease.owner, lease.generation, Date.now()).changes === 1;
  }

  getRun(id: string): StoredRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return {
       id: String(row.id), workflowId: String(row.workflow_id), repository: row.repository ? String(row.repository) : undefined,
        event: JSON.parse(String(row.event_json)) as Event, agent: String(row.agent), execution: row.execution ? String(row.execution) : undefined,
         workspace: row.workspace ? String(row.workspace) : undefined,
         resourceKey: row.resource_key ? String(row.resource_key) : undefined,
       status: row.status as RunStatus, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        error: row.error ? String(row.error) : undefined,
        activation: row.activation_json ? JSON.parse(String(row.activation_json)) as EventActivation : undefined,
        effectiveWorkspace: row.effective_workspace_json ? JSON.parse(String(row.effective_workspace_json)) as EffectiveWorkspace : undefined,
        phase: row.phase ? String(row.phase) : undefined, workflowHash: row.workflow_hash ? String(row.workflow_hash) : undefined,
        sourceRevision: row.source_revision ? String(row.source_revision) : undefined, planHash: row.plan_hash ? String(row.plan_hash) : undefined,
        verification: row.verification_json ? JSON.parse(String(row.verification_json)) as VerificationResult[] : undefined,
        attempts: Number(row.attempts ?? 0),
        availableAt: row.available_at === null ? undefined : Number(row.available_at),
        deadline: row.deadline === null ? undefined : Number(row.deadline),
        cancellation: row.cancel_requested_at ? { requestedAt: String(row.cancel_requested_at), reason: row.cancel_reason ? String(row.cancel_reason) : undefined } : undefined,
        outcome: row.outcome_json ? JSON.parse(String(row.outcome_json)) : undefined,
        leaseGeneration: Number(row.lease_generation ?? 0),
       };
  }

  getWorkflowSnapshot(runId: string): Workflow | undefined {
    const row = this.db.prepare("SELECT workflow_json FROM runs WHERE id = ?").get(runId) as { workflow_json: string | null } | undefined;
    if (!row?.workflow_json) return undefined;
    try { return JSON.parse(row.workflow_json) as Workflow; }
    catch { return undefined; }
  }

  insertReplay(record: ReplayRecord, event: Event, run: Run, workflow: Workflow, maxActiveRuns = Number.MAX_SAFE_INTEGER): void {
    const insert = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT COUNT(*) count FROM runs
        WHERE status IN ('queued', 'preparing', 'waiting', 'running')`).get() as { count: number };
      if (active.count >= maxActiveRuns) throw new Error("Run queue is at capacity");
      this.db.prepare(`INSERT INTO replay_requests
        (id, source_run_id, root_run_id, run_id, event_id, workflow_mode, workflow_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, record.sourceRunId, record.rootRunId, record.runId, record.eventId,
        record.workflowMode, record.workflowHash, record.createdAt,
      );
      if (!this.insertEvent(event)) throw new Error(`Replay event already exists: ${event.id}`);
      if (this.insertRunStatement(run, workflow.agent, workflow.execution, workflow.workspace, { workflow, workflowHash: record.workflowHash }) !== 1) {
        throw new Error(`Replay run route already exists for workflow '${workflow.id}' and event '${event.id}'`);
      }
    });
    insert();
  }

  getReplayForRun(runId: string): ReplayRecord | undefined {
    const row = this.db.prepare("SELECT * FROM replay_requests WHERE run_id = ?").get(runId) as Record<string, string> | undefined;
    return row ? {
      id: row.id!, sourceRunId: row.source_run_id!, rootRunId: row.root_run_id!, runId: row.run_id!,
      eventId: row.event_id!, workflowMode: row.workflow_mode as ReplayRecord["workflowMode"],
      workflowHash: row.workflow_hash!, createdAt: row.created_at!,
    } : undefined;
  }

  getRerouteForEvent(eventId: string): RerouteRecord | undefined {
    const row = this.db.prepare("SELECT * FROM reroute_requests WHERE event_id = ?").get(eventId) as Record<string, string> | undefined;
    return row ? {
      id: row.id!, sourceEventId: row.source_event_id!, eventId: row.event_id!, createdAt: row.created_at!,
    } : undefined;
  }

  getRerouteForSourceEvent(sourceEventId: string): RerouteRecord | undefined {
    const row = this.db.prepare("SELECT * FROM reroute_requests WHERE source_event_id = ?").get(sourceEventId) as Record<string, string> | undefined;
    return row ? {
      id: row.id!, sourceEventId: row.source_event_id!, eventId: row.event_id!, createdAt: row.created_at!,
    } : undefined;
  }

  getActiveReplay(rootRunId: string): string | undefined {
    const row = this.db.prepare(`SELECT rr.run_id FROM replay_requests rr
      JOIN runs r ON r.id = rr.run_id
      WHERE rr.root_run_id = ? AND r.status IN ('queued', 'preparing', 'waiting', 'running')
      ORDER BY rr.created_at DESC LIMIT 1`).get(rootRunId) as { run_id: string } | undefined;
    return row?.run_id;
  }

  listRuns(limit = 50): StoredRun[] {
    return (this.db.prepare("SELECT id FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ id: string }>)
      .map(({ id }) => this.getRun(id)!);
  }

  listRunsForDisplay(options: { since?: string; limit?: number } = {}): StoredRun[] {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new Error("Run list limit must be a positive integer");
    const active = (this.db.prepare(`SELECT id FROM runs
      WHERE status IN ('queued', 'preparing', 'waiting', 'running')
      ORDER BY created_at, id`).all() as Array<{ id: string }>).map(({ id }) => this.getRun(id)!);
    const where = `status NOT IN ('queued', 'preparing', 'waiting', 'running')${options.since ? " AND updated_at >= ?" : ""}`;
    const parameters: Array<string | number> = options.since ? [options.since] : [];
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) parameters.push(options.limit);
    const terminal = (this.db.prepare(`SELECT id FROM runs WHERE ${where} ORDER BY updated_at DESC, id DESC${limit}`)
      .all(...parameters) as Array<{ id: string }>).reverse().map(({ id }) => this.getRun(id)!);
    return [...terminal, ...active];
  }

  pruneHistory(cutoff: string): string[] {
    const prune = this.db.transaction(() => {
      const candidates = this.db.prepare(`WITH RECURSIVE active_ancestors(id) AS (
          SELECT c.parent_run_id FROM child_requests c JOIN runs child ON child.id = c.run_id
          WHERE child.status IN ('queued', 'preparing', 'waiting', 'running')
          UNION SELECT c.parent_run_id FROM child_requests c JOIN active_ancestors a ON a.id = c.run_id
        ) SELECT r.id FROM runs r
        WHERE r.status IN ('completed', 'failed', 'cancelled', 'interrupted') AND r.updated_at < ?
          AND r.id NOT IN (SELECT id FROM active_ancestors)
          AND NOT EXISTS (SELECT 1 FROM lifecycle_outbox l WHERE l.run_id = r.id AND l.status != 'delivered')
          AND NOT EXISTS (SELECT 1 FROM safe_actions a WHERE a.run_id = r.id AND a.status IN ('requested', 'proposed', 'validated'))
          AND NOT EXISTS (SELECT 1 FROM action_plans p WHERE p.run_id = r.id AND p.status IN ('validated', 'applying'))
          AND NOT EXISTS (
            SELECT 1 FROM action_plans p JOIN action_effects e ON e.plan_id = p.id
            WHERE p.run_id = r.id AND e.status IN ('pending', 'executing')
          )
          AND NOT EXISTS (
            SELECT 1 FROM replay_requests rr JOIN runs replay_run ON replay_run.id = rr.run_id
            WHERE replay_run.status IN ('queued', 'preparing', 'waiting', 'running')
              AND (rr.source_run_id = r.id OR rr.root_run_id = r.id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM child_requests c JOIN runs related ON related.id = CASE WHEN c.parent_run_id = r.id THEN c.run_id ELSE c.parent_run_id END
            WHERE (c.parent_run_id = r.id OR c.run_id = r.id) AND related.status IN ('queued', 'preparing', 'waiting', 'running')
          )
        ORDER BY r.updated_at, r.id`).all(cutoff) as Array<{ id: string }>;
      const removeEffects = this.db.prepare("DELETE FROM action_effects WHERE plan_id IN (SELECT id FROM action_plans WHERE run_id = ?)");
      const removePlans = this.db.prepare("DELETE FROM action_plans WHERE run_id = ?");
      const removeActions = this.db.prepare("DELETE FROM safe_actions WHERE run_id = ?");
      const removeArtifacts = this.db.prepare("DELETE FROM artifacts WHERE run_id = ?");
      const removeHandoffs = this.db.prepare("DELETE FROM agent_handoffs WHERE run_id = ?");
      const removeLifecycle = this.db.prepare("DELETE FROM lifecycle_outbox WHERE run_id = ?");
      const removeReplay = this.db.prepare("DELETE FROM replay_requests WHERE run_id = ?");
      const removeRun = this.db.prepare("DELETE FROM runs WHERE id = ?");
      const removeSteps = this.db.prepare("DELETE FROM run_steps WHERE run_id = ?");
      for (const { id } of candidates) {
        removeEffects.run(id);
        removePlans.run(id);
        removeActions.run(id);
        this.db.prepare("DELETE FROM scripted_action_requests WHERE run_id = ?").run(id);
        removeArtifacts.run(id);
        removeHandoffs.run(id);
        removeLifecycle.run(id);
        removeReplay.run(id);
        removeSteps.run(id);
        removeRun.run(id);
      }
      this.db.prepare("DELETE FROM child_requests WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = child_requests.parent_run_id OR runs.id = child_requests.run_id)").run();
      return candidates.map(({ id }) => id);
    });
    return prune.immediate();
  }

  insertAction(record: SafeActionRecord): void {
    this.db.prepare(`INSERT INTO safe_actions
      (id, run_id, action, payload, status, reason, created_at, executed_at, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.runId, record.action, JSON.stringify(record.payload), record.status,
        record.reason ?? null, record.createdAt, record.executedAt ?? null,
        record.result === undefined ? null : JSON.stringify(record.result));
  }

  admitActionRequest(lease: RunLease, stepId: string, attempt: number, key: string, hash: string, record: SafeActionRecord): SafeActionRecord {
    return this.db.transaction(() => {
      const active = this.db.prepare(`SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
        AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ? AND deadline > ?`)
        .get(lease.runId, lease.owner, lease.generation, Date.now(), Date.now());
      const step = this.listSteps(lease.runId).filter(item => item.id === stepId).at(-1);
      if (!active || record.runId !== lease.runId || step?.status !== "running" || step.attempt !== attempt) throw new Error("action_parent_unavailable");
      const existing = this.db.prepare("SELECT request_hash, action_id FROM scripted_action_requests WHERE run_id = ? AND step_id = ? AND request_key = ?")
        .get(lease.runId, stepId, key);
      if (existing) {
        if (typeof existing !== "object" || !("request_hash" in existing) || !("action_id" in existing)) throw new Error("Invalid persisted action request");
        if (existing.request_hash === hash) {
          const action = this.listActions(lease.runId).find(item => item.id === existing.action_id);
          if (!action) throw new Error("action_request_expired");
          this.db.prepare("UPDATE scripted_action_requests SET step_attempt = ? WHERE action_id = ?").run(attempt, action.id);
          return action;
        }
        const rejected: SafeActionRecord = { ...record, status: "rejected", reason: "safe_action_request_key_conflict" };
        this.insertAction(rejected);
        return rejected;
      }
      if (record.status === "proposed" && this.listActions(lease.runId).some(item => ["proposed", "validated", "executed", "failed", "staged"].includes(item.status))) {
        record = { ...record, status: "rejected", reason: "safe_action_plan_multiple_effects" };
      }
      this.insertAction(record);
      this.db.prepare("INSERT INTO scripted_action_requests VALUES (?, ?, ?, ?, ?, ?)").run(lease.runId, stepId, key, hash, record.id, attempt);
      return record;
    }).immediate();
  }

  discardUnconfirmedScriptedActions(runId: string): void {
    const requests = this.db.prepare("SELECT action_id, step_id, step_attempt FROM scripted_action_requests WHERE run_id = ?").all(runId);
    const steps = this.listSteps(runId);
    for (const request of requests) {
      if (!request || typeof request !== "object" || !("action_id" in request) || typeof request.action_id !== "string" || !("step_id" in request) || !("step_attempt" in request)) throw new Error("Invalid persisted action request");
      if (!steps.some(step => step.id === request.step_id && step.attempt === request.step_attempt && step.status === "succeeded")) {
        this.db.prepare("UPDATE safe_actions SET status = 'rejected', reason = 'safe_action_request_step_not_successful' WHERE id = ? AND status = 'proposed'").run(request.action_id);
      }
    }
  }

  updateAction(id: string, status: SafeActionStatus, reason?: string, result?: unknown): void {
    this.db.prepare("UPDATE safe_actions SET status = ?, reason = ?, executed_at = ?, result = ? WHERE id = ?")
      .run(status, reason ?? null, new Date().toISOString(), result === undefined ? null : JSON.stringify(result), id);
  }

  countAcceptedActions(runId: string, action: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) count FROM safe_actions
       WHERE run_id = ? AND action = ? AND status IN ('proposed', 'validated', 'executed', 'failed', 'staged')`)
      .get(runId, action) as { count: number };
    return row.count;
  }

  discardPendingActions(runId: string, reason: string): void {
    this.db.prepare(`UPDATE safe_actions SET status = 'rejected', reason = ?, executed_at = ?
      WHERE run_id = ? AND status IN ('requested', 'proposed')`).run(reason, new Date().toISOString(), runId);
  }

  insertArtifact(id: string, runId: string, kind: string, artifact: WorkspaceArtifact, hash: string, createdAt: string): void {
    this.db.prepare(`INSERT INTO artifacts(id, run_id, kind, manifest_json, manifest_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, runId, kind, JSON.stringify(artifact), hash, createdAt);
  }

  getArtifact(runId: string): WorkspaceArtifact | undefined {
    const row = this.db.prepare("SELECT manifest_json FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId) as { manifest_json: string } | undefined;
    return row ? JSON.parse(row.manifest_json) as WorkspaceArtifact : undefined;
  }

  insertHandoff(handoff: AgentHandoff): void {
    this.db.prepare(`INSERT OR REPLACE INTO agent_handoffs
      (id, run_id, role, ordinal, payload_json, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      handoff.id, handoff.runId, handoff.role, handoff.ordinal,
      JSON.stringify(handoff.payload), handoff.hash, handoff.createdAt,
    );
  }

  listHandoffs(runId: string): AgentHandoff[] {
    const rows = this.db.prepare("SELECT * FROM agent_handoffs WHERE run_id = ? ORDER BY ordinal").all(runId) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), role: row.role as AgentHandoff["role"], ordinal: Number(row.ordinal),
      payload: JSON.parse(String(row.payload_json)) as JsonValue, hash: String(row.payload_hash), createdAt: String(row.created_at),
    }));
  }

  insertPlan(record: ActionPlanRecord, effects: readonly Pick<ActionEffectRecord, "id" | "ordinal" | "idempotencyKey" | "prepared">[] = []): void {
    const insert = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO action_plans(id, run_id, plan_json, plan_hash, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.runId, JSON.stringify(record.plan), record.hash,
        record.status, record.reason ?? null, record.createdAt);
      this.db.prepare("UPDATE runs SET plan_hash = ?, updated_at = ? WHERE id = ?").run(record.hash, new Date().toISOString(), record.runId);
      for (const effect of effects) this.insertEffect(effect.id, record.id, effect.ordinal, effect.idempotencyKey, effect.prepared);
    });
    insert();
  }

  updatePlan(id: string, status: ActionPlanRecord["status"], reason?: string): void {
    this.db.prepare("UPDATE action_plans SET status = ?, reason = ?, applied_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE applied_at END WHERE id = ?")
      .run(status, reason ?? null, status, new Date().toISOString(), id);
  }

  insertEffect(id: string, planId: string, ordinal: number, idempotencyKey: string, prepared: unknown): void {
    this.db.prepare(`INSERT INTO action_effects(id, plan_id, ordinal, idempotency_key, prepared_json, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, planId, ordinal, idempotencyKey, JSON.stringify(prepared), new Date().toISOString());
  }

  updateEffect(id: string, status: string, result?: unknown, error?: string): void {
    this.db.prepare(`UPDATE action_effects SET status = ?, attempts = attempts + CASE WHEN ? = 'executing' THEN 1 ELSE 0 END,
      result_json = ?, error = ?, updated_at = ? WHERE id = ?`).run(status, status,
      result === undefined ? null : JSON.stringify(result), error ?? null, new Date().toISOString(), id);
  }

  getPlan(runId: string): ActionPlanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM action_plans WHERE run_id = ?").get(runId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    return { id: row.id!, runId: row.run_id!, plan: JSON.parse(row.plan_json!), hash: row.plan_hash!,
      status: row.status as ActionPlanRecord["status"], reason: row.reason ?? undefined, createdAt: row.created_at! };
  }

  listEffects(planId: string, statuses?: readonly ActionEffectRecord["status"][]): ActionEffectRecord[] {
    const rows = (statuses?.length
      ? this.db.prepare(`SELECT * FROM action_effects WHERE plan_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY ordinal`).all(planId, ...statuses)
      : this.db.prepare("SELECT * FROM action_effects WHERE plan_id = ? ORDER BY ordinal").all(planId)) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id), planId: String(row.plan_id), ordinal: Number(row.ordinal),
      idempotencyKey: String(row.idempotency_key), prepared: JSON.parse(String(row.prepared_json)),
      status: row.status as ActionEffectRecord["status"], attempts: Number(row.attempts),
      result: row.result_json ? JSON.parse(String(row.result_json)) : undefined,
      error: row.error ? String(row.error) : undefined,
    }));
  }

  listRecoverablePlans(): Array<{ run: StoredRun; workflow: Workflow; plan: ActionPlanRecord; effects: ActionEffectRecord[] }> {
    const rows = this.db.prepare(`SELECT p.run_id FROM action_plans p
      JOIN runs r ON r.id = p.run_id
      WHERE p.status IN ('validated', 'applying') ORDER BY p.created_at`).all() as Array<{ run_id: string }>;
    return rows.flatMap(({ run_id }) => {
      const run = this.getRun(run_id);
      const plan = this.getPlan(run_id);
      const workflowRow = this.db.prepare("SELECT workflow_json FROM runs WHERE id = ?").get(run_id) as { workflow_json: string | null } | undefined;
      if (!run || !plan || !workflowRow?.workflow_json) return [];
      try {
        const effects = this.listEffects(plan.id, ["pending", "executing"]);
        return effects.length ? [{ run, workflow: JSON.parse(workflowRow.workflow_json) as Workflow, plan, effects }] : [];
      } catch { return []; }
    });
  }

  claimRun(id: string, owner: string, leaseMs = 60_000): boolean {
    const now = Date.now();
    const result = this.db.prepare(`UPDATE runs SET lease_owner = ?, lease_expires_at = ?, lease_generation = lease_generation + 1,
      attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at < ?)`)
      .run(owner, now + leaseMs, new Date(now).toISOString(), id, now);
    return result.changes === 1;
  }

  claimEligibleRun(owner: string, leaseMs = 60_000, now = Date.now(), maxActive = Number.MAX_SAFE_INTEGER, defaultTimeout = 3_600_000): RunLease | undefined {
    const claim = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT COUNT(*) count FROM runs
        WHERE status IN ('queued', 'preparing', 'waiting', 'running') AND lease_owner IS NOT NULL AND lease_expires_at >= ?`).get(now) as { count: number };
      if (active.count >= maxActive) return undefined;
      const row = this.db.prepare(`SELECT r.id, r.workflow_json FROM runs r
        WHERE r.status = 'queued' AND r.cancel_requested_at IS NULL
          AND (available_at IS NULL OR available_at <= ?)
          AND (deadline IS NULL OR deadline > ?)
          AND (lease_owner IS NULL OR lease_expires_at < ?)
          AND (resource_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM runs held WHERE held.id != r.id AND held.resource_key = r.resource_key
              AND ((held.status IN ('queued', 'preparing', 'waiting', 'running')
                AND held.lease_owner IS NOT NULL AND held.lease_expires_at >= ?)
                OR EXISTS (SELECT 1 FROM lifecycle_outbox l WHERE l.run_id = held.id AND l.event = 'run:finalized' AND l.status != 'delivered'))))
        ORDER BY COALESCE(available_at, 0), created_at, id LIMIT 1`).get(now, now, now, now) as { id: string; workflow_json: string | null } | undefined;
      if (!row) return undefined;
      const expiresAt = now + leaseMs;
      const timeout = row.workflow_json ? (JSON.parse(row.workflow_json) as Workflow).timeout ?? defaultTimeout : defaultTimeout;
      const changed = this.db.prepare(`UPDATE runs SET lease_owner = ?, lease_expires_at = ?,
        lease_generation = lease_generation + 1, attempts = attempts + 1, updated_at = ?,
        deadline = COALESCE(deadline, ?)
        WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at < ?)`).run(
        owner, expiresAt, new Date(now).toISOString(), now + timeout, row.id, now,
      ).changes;
      if (!changed) return undefined;
      const generation = this.db.prepare("SELECT lease_generation generation FROM runs WHERE id = ?")
        .get(row.id) as { generation: number };
      return { runId: row.id, owner, generation: generation.generation, expiresAt };
    });
    return claim.immediate();
  }

  updateRunFenced(lease: RunLease, status: RunStatus, options?: {
    error?: string; phase?: string; outcome?: unknown; availableAt?: number;
    lifecycle?: { id: string; event: string; payload: unknown; availableAt?: number };
  }): boolean {
    const update = this.db.transaction(() => {
      const now = Date.now();
      const changed = this.db.prepare(`UPDATE runs SET status = ?, error = ?, phase = COALESCE(?, phase),
        outcome_json = COALESCE(?, outcome_json), available_at = COALESCE(?, available_at), updated_at = ?
        WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ?`)
        .run(status, options?.error ?? null, options?.phase ?? null,
          options?.outcome === undefined ? null : JSON.stringify(options.outcome), options?.availableAt ?? null,
          new Date(now).toISOString(), lease.runId, lease.owner, lease.generation, now).changes;
      if (!changed) return false;
      if (options?.lifecycle) this.enqueueLifecycle({ ...options.lifecycle, runId: lease.runId });
      return true;
    });
    return update.immediate();
  }

  renewRunFenced(lease: RunLease, leaseMs = 60_000, now = Date.now()): RunLease | undefined {
    const expiresAt = now + leaseMs;
    const changed = this.db.prepare(`UPDATE runs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ?`)
      .run(expiresAt, new Date(now).toISOString(), lease.runId, lease.owner, lease.generation, now).changes;
    return changed ? { ...lease, expiresAt } : undefined;
  }

  releaseRunFenced(lease: RunLease): boolean {
    return this.db.prepare(`UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND lease_owner = ? AND lease_generation = ?`)
      .run(lease.runId, lease.owner, lease.generation).changes === 1;
  }

  requestRunCancellation(id: string, reason?: string, requestedAt = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
      cancel_reason = COALESCE(cancel_reason, ?), updated_at = ?
      WHERE id = ? AND status IN ('queued', 'preparing', 'waiting', 'running')`)
      .run(requestedAt, reason ?? null, requestedAt, id).changes === 1;
  }

  cancelQueuedRun(id: string, reason: string, outcome: unknown, nowMs = Date.now()): boolean {
    const cancel = this.db.transaction(() => {
      const now = new Date().toISOString();
      const changed = this.db.prepare(`UPDATE runs SET status = 'cancelled', phase = 'cancelled', error = ?,
        cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_reason = COALESCE(cancel_reason, ?),
        outcome_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'
        AND (lease_owner IS NULL OR lease_expires_at < ?)`)
        .run(reason, now, reason, JSON.stringify(outcome), now, id, nowMs).changes;
      if (changed) this.enqueueLifecycle({ id: `run-finalized:${id}`, runId: id, event: "run:finalized",
        payload: { status: "cancelled", succeeded: false, error: reason } });
      return changed === 1;
    });
    return cancel.immediate();
  }

  hasPendingRuns(): boolean {
    return this.db.prepare(`SELECT 1 FROM runs WHERE status IN ('queued', 'preparing', 'waiting', 'running') LIMIT 1`).get() !== undefined;
  }

  hasPendingLifecycle(): boolean {
    return this.db.prepare("SELECT 1 FROM lifecycle_outbox WHERE status != 'delivered' LIMIT 1").get() !== undefined;
  }

  recoverExpiredRuns(maxAttempts: number, nowMs = Date.now()): void {
    const recover = this.db.transaction(() => {
      const now = new Date(nowMs).toISOString();
      this.recoverCancellations(nowMs);
      const safe = this.db.prepare(`SELECT id FROM runs WHERE status IN ('preparing', 'waiting')
        AND lease_expires_at < ? AND NOT EXISTS (SELECT 1 FROM action_plans WHERE action_plans.run_id = runs.id)`)
        .all(nowMs) as Array<{ id: string }>;
      for (const { id } of safe) this.db.prepare(`UPDATE runs SET status = 'queued', phase = 'queued',
        error = 'Recovered after expired pre-agent lease', attempts = MAX(0, attempts - 1),
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      const retryable = this.db.prepare(`SELECT id FROM runs WHERE status = 'running' AND attempts < ?
        AND lease_expires_at < ? AND NOT EXISTS (SELECT 1 FROM action_plans WHERE action_plans.run_id = runs.id)
        AND json_extract(workflow_json, '$.task.kind') IS NOT 'steps'`)
        .all(maxAttempts, nowMs) as Array<{ id: string }>;
      for (const { id } of retryable) this.db.prepare(`UPDATE runs SET status = 'queued', phase = 'queued',
        error = 'Recovered after expired run lease', lease_owner = NULL, lease_expires_at = NULL,
        available_at = ?, updated_at = ? WHERE id = ?`).run(nowMs, now, id);
      const terminal = this.db.prepare(`SELECT id, attempts FROM runs WHERE status IN ('preparing', 'waiting', 'running')
        AND lease_expires_at < ? AND (attempts >= ? OR json_extract(workflow_json, '$.task.kind') = 'steps' OR EXISTS (SELECT 1 FROM action_plans WHERE action_plans.run_id = runs.id))`)
        .all(nowMs, maxAttempts) as Array<{ id: string; attempts: number }>;
      for (const item of terminal) {
        if (!this.getPlan(item.id)) this.discardPendingActions(item.id, "run_lease_expired_before_plan");
        this.interruptSteps(item.id);
        const error = "Run lease expired after execution may have produced effects";
        this.db.prepare(`UPDATE runs SET status = 'interrupted', phase = 'interrupted', error = ?,
          outcome_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
          .run(error, JSON.stringify({ version: 1, outcome: "failed", reason: error }), now, item.id);
        this.enqueueLifecycle({ id: `run-finalized:${item.id}`, runId: item.id, event: "run:finalized",
          payload: { status: "interrupted", attempt: item.attempts, succeeded: false, error } });
      }
    });
    recover.immediate();
  }

  interruptSteps(runId: string): void {
    for (const record of this.listSteps(runId)) if (record.status === "running" || record.status === "pending") {
      this.db.prepare("UPDATE run_steps SET record_json = ? WHERE run_id = ? AND step_id = ? AND attempt = ?")
        .run(JSON.stringify({ ...record, status: record.status === "pending" ? "skipped" : "interrupted", finishedAt: new Date().toISOString(), error: "Execution interrupted; effects may have occurred" }), runId, record.id, record.attempt);
    }
  }

  renewRun(id: string, owner: string, leaseMs = 60_000): boolean {
    const now = Date.now();
    return this.db.prepare("UPDATE runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?")
      .run(now + leaseMs, new Date(now).toISOString(), id, owner).changes === 1;
  }

  releaseRun(id: string, owner: string): void {
    this.db.prepare("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?").run(id, owner);
  }

  enqueueLifecycle(record: { id: string; runId: string; event: string; payload: unknown; availableAt?: number; createdAt?: string }): boolean {
    const createdAt = record.createdAt ?? new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO lifecycle_outbox
      (id, run_id, event, payload_json, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.runId, record.event, JSON.stringify(record.payload), record.availableAt ?? Date.now(), createdAt).changes === 1;
  }

  claimLifecycle(owner: string, leaseMs = 60_000, now = Date.now()): LifecycleOutboxRecord | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM lifecycle_outbox
        WHERE status IN ('pending', 'delivering') AND available_at <= ?
          AND (lease_owner IS NULL OR lease_expires_at < ?)
        ORDER BY available_at, created_at, id LIMIT 1`).get(now, now) as { id: string } | undefined;
      if (!row) return undefined;
      const changed = this.db.prepare(`UPDATE lifecycle_outbox SET status = 'delivering', lease_owner = ?,
        lease_generation = lease_generation + 1, lease_expires_at = ?, attempts = attempts + 1
        WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at < ?)`)
        .run(owner, now + leaseMs, row.id, now).changes;
      if (!changed) return undefined;
      return this.getLifecycle(row.id);
    });
    return claim.immediate();
  }

  completeLifecycle(id: string, owner: string, generation: number, error?: string, retryAt?: number): boolean {
    const delivered = error === undefined;
    return this.db.prepare(`UPDATE lifecycle_outbox SET status = ?, error = ?, available_at = COALESCE(?, available_at),
      delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND lease_owner = ? AND lease_generation = ?`)
      .run(delivered ? "delivered" : "pending", error ?? null, retryAt ?? null,
        delivered ? new Date().toISOString() : null, id, owner, generation).changes === 1;
  }

  renewLifecycle(id: string, owner: string, generation: number, leaseMs = 60_000): boolean {
    const now = Date.now();
    return this.db.prepare(`UPDATE lifecycle_outbox SET lease_expires_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_generation = ? AND lease_expires_at >= ?`)
      .run(now + leaseMs, id, owner, generation, now).changes === 1;
  }

  getLifecycle(id: string): LifecycleOutboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM lifecycle_outbox WHERE id = ?").get(id) as Record<string, string | number | null> | undefined;
    return row ? {
      id: String(row.id), runId: String(row.run_id), event: String(row.event), payload: JSON.parse(String(row.payload_json)),
      status: row.status as LifecycleOutboxRecord["status"], availableAt: Number(row.available_at), attempts: Number(row.attempts),
      leaseGeneration: Number(row.lease_generation), createdAt: String(row.created_at),
      deliveredAt: row.delivered_at ? String(row.delivered_at) : undefined, error: row.error ? String(row.error) : undefined,
    } : undefined;
  }

  updateSourceHealth(record: SourceHealthRecord): void {
    this.db.prepare(`INSERT INTO source_health
      (source, status, consecutive_failures, last_success_at, last_failure_at, next_attempt_at, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET status = excluded.status, consecutive_failures = excluded.consecutive_failures,
      last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at,
      next_attempt_at = excluded.next_attempt_at, error = excluded.error, updated_at = excluded.updated_at`)
      .run(record.source, record.status, record.consecutiveFailures, record.lastSuccessAt ?? null,
        record.lastFailureAt ?? null, record.nextAttemptAt ?? null, record.error ?? null, record.updatedAt);
  }

  getSourceHealth(source: string): SourceHealthRecord | undefined {
    const row = this.db.prepare("SELECT * FROM source_health WHERE source = ?").get(source) as Record<string, string | number | null> | undefined;
    return row ? {
      source: String(row.source), status: row.status as SourceHealthRecord["status"], consecutiveFailures: Number(row.consecutive_failures),
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : undefined,
      lastFailureAt: row.last_failure_at ? String(row.last_failure_at) : undefined,
      nextAttemptAt: row.next_attempt_at === null ? undefined : Number(row.next_attempt_at),
      error: row.error ? String(row.error) : undefined, updatedAt: String(row.updated_at),
    } : undefined;
  }

  listSourceHealth(): SourceHealthRecord[] {
    const rows = this.db.prepare("SELECT source FROM source_health ORDER BY source").all() as Array<{ source: string }>;
    return rows.map(({ source }) => this.getSourceHealth(source)!);
  }

  recoverInterruptedRuns(maxAttempts: number): void {
    const recover = this.db.transaction(() => {
      const now = new Date().toISOString();
      // Preparation and case-lock interruptions are safe to replay: the agent
      // has not received control and therefore cannot have produced effects.
      const nowMs = Date.now();
      this.recoverCancellations(nowMs);
      const safelyInterrupted = this.db.prepare(`SELECT id FROM runs
        WHERE (status IN ('preparing', 'waiting') OR (status = 'interrupted' AND phase IN ('preparing', 'waiting')))
        AND (lease_owner IS NULL OR lease_expires_at < ?)
        AND NOT EXISTS (SELECT 1 FROM action_plans WHERE action_plans.run_id = runs.id)`).all(nowMs) as Array<{ id: string }>;
      for (const { id } of safelyInterrupted) {
        this.discardPendingActions(id, "run_recovered_before_agent");
        this.db.prepare(`UPDATE runs SET status = 'queued', error = 'Recovered after pre-agent interruption', phase = 'queued',
          attempts = MAX(0, attempts - 1), lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      }
      const recoverable = this.db.prepare(`SELECT id FROM runs
         WHERE status = 'running' AND attempts < ? AND (lease_owner IS NULL OR lease_expires_at < ?)
        AND json_extract(workflow_json, '$.task.kind') IS NOT 'steps'
        AND NOT EXISTS (SELECT 1 FROM action_plans WHERE action_plans.run_id = runs.id)`).all(maxAttempts, nowMs) as Array<{ id: string }>;
      for (const { id } of recoverable) {
        this.discardPendingActions(id, "run_recovered_before_plan");
        this.db.prepare(`UPDATE runs SET status = 'queued', error = 'Recovered after daemon interruption', phase = 'queued',
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      }
      this.db.prepare(`UPDATE runs SET status = 'interrupted', error = 'Daemon stopped before run completion', phase = 'interrupted',
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE status IN ('preparing', 'running', 'waiting') AND (lease_owner IS NULL OR lease_expires_at < ?)`).run(now, nowMs);
      const scripts = this.db.prepare("SELECT id FROM runs WHERE status = 'interrupted' AND json_extract(workflow_json, '$.task.kind') = 'steps'").all();
      for (const row of scripts) if (row && typeof row === "object" && "id" in row && typeof row.id === "string") {
        if (!this.getPlan(row.id)) this.discardPendingActions(row.id, "scripted_run_interrupted_before_plan");
        this.interruptSteps(row.id);
      }
      this.db.prepare(`UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status = 'queued' AND (lease_owner IS NULL OR lease_expires_at < ?)`).run(now, nowMs);
      this.db.prepare(`UPDATE action_plans SET status = CASE WHEN EXISTS (
          SELECT 1 FROM action_effects WHERE action_effects.plan_id = action_plans.id AND action_effects.status = 'failed'
        ) THEN 'failed' ELSE 'completed' END,
        applied_at = ?
        WHERE status IN ('validated', 'applying') AND NOT EXISTS (
          SELECT 1 FROM action_effects WHERE action_effects.plan_id = action_plans.id AND action_effects.status IN ('pending', 'executing')
        )`).run(now);
      this.db.prepare(`UPDATE runs SET status = CASE WHEN EXISTS (
          SELECT 1 FROM action_plans p JOIN action_effects e ON e.plan_id = p.id
          WHERE p.run_id = runs.id AND e.status = 'failed'
        ) THEN 'failed' ELSE 'completed' END,
        error = CASE WHEN EXISTS (
          SELECT 1 FROM action_plans p JOIN action_effects e ON e.plan_id = p.id
          WHERE p.run_id = runs.id AND e.status = 'failed'
        ) THEN 'Safe Action effect failed' ELSE NULL END,
        phase = 'recovered', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status = 'interrupted' AND EXISTS (
          SELECT 1 FROM action_plans p WHERE p.run_id = runs.id AND p.status IN ('completed', 'failed')
        )`).run(now);
      // Plans are idempotently reconciled instead of rerunning their agents.
      this.db.prepare(`UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id IN (SELECT run_id FROM action_plans WHERE status IN ('validated', 'applying'))`).run(now);
      const finalized = this.db.prepare(`SELECT id FROM runs WHERE (status = 'interrupted' OR phase = 'recovered')
        AND NOT EXISTS (SELECT 1 FROM lifecycle_outbox l WHERE l.id = 'run-finalized:' || runs.id)`).all();
      for (const row of finalized) {
        const { id } = z.object({ id: z.string() }).parse(row);
        const run = this.getRun(id)!;
        this.enqueueLifecycle({ id: `run-finalized:${id}`, runId: id, event: "run:finalized",
          payload: { status: run.status, succeeded: run.status === "completed", ...(run.error ? { error: run.error } : {}), ...(run.outcome ? { outcome: run.outcome } : {}) } });
      }
    });
    recover();
  }

  private recoverCancellations(now: number): void {
    const rows = this.db.prepare(`SELECT id, cancel_reason FROM runs
      WHERE status IN ('queued', 'preparing', 'waiting', 'running') AND cancel_requested_at IS NOT NULL
        AND (lease_owner IS NULL OR lease_expires_at < ?)
        AND NOT EXISTS (SELECT 1 FROM action_plans p WHERE p.run_id = runs.id AND p.status IN ('validated', 'applying'))`).all(now);
    for (const row of rows) {
      const { id, cancel_reason: reason } = z.object({ id: z.string(), cancel_reason: z.string().nullable() }).parse(row);
      const message = reason ?? "Run cancelled";
      this.discardPendingActions(id, "run_cancelled"); this.interruptSteps(id);
      const outcome = { version: 1, outcome: "blocked", reason: message };
      this.db.prepare(`UPDATE runs SET status = 'cancelled', phase = 'cancelled', outcome_json = ?, error = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(JSON.stringify(outcome), message, new Date(now).toISOString(), id);
      this.enqueueLifecycle({ id: `run-finalized:${id}`, runId: id, event: "run:finalized", payload: { status: "cancelled", succeeded: false, outcome } });
    }
  }

  assignQueuedResource(id: string, resourceKey: string): void {
    this.db.prepare("UPDATE runs SET resource_key = ? WHERE id = ? AND status = 'queued' AND resource_key IS NULL AND lease_owner IS NULL").run(resourceKey, id);
  }

  listQueuedRuns(): Array<{ run: Run; workflow: Workflow }> {
    const rows = this.db.prepare("SELECT id, workflow_json FROM runs WHERE status = 'queued' AND workflow_json IS NOT NULL ORDER BY created_at").all() as Array<{ id: string; workflow_json: string }>;
    return rows.flatMap((row) => {
      const run = this.getRun(row.id);
      if (!run) return [];
      try { return [{ run, workflow: JSON.parse(row.workflow_json) as Workflow }]; }
      catch { return []; }
    });
  }

  listActions(runId: string): SafeActionRecord[] {
    const rows = this.db.prepare("SELECT * FROM safe_actions WHERE run_id = ? ORDER BY created_at").all(runId) as Record<string, string | null>[];
    return rows.map((row) => ({
      id: row.id!, runId: row.run_id!, action: row.action!, payload: JSON.parse(row.payload!),
      status: row.status as SafeActionStatus, reason: row.reason ?? undefined, createdAt: row.created_at!,
      executedAt: row.executed_at ?? undefined, result: row.result ? JSON.parse(row.result) : undefined,
    }));
  }

  state(namespace: string) {
    return {
      get: <T extends JsonValue>(key: string): T | undefined => {
        const row = this.db.prepare("SELECT value FROM extension_state WHERE namespace = ? AND key = ?")
          .get(namespace, key) as { value: string } | undefined;
        return row ? JSON.parse(row.value) as T : undefined;
      },
      set: <T extends JsonValue>(key: string, value: T): void => {
        this.db.prepare(`INSERT INTO extension_state(namespace, key, value) VALUES (?, ?, ?)
          ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`).run(namespace, key, JSON.stringify(value));
      },
      delete: (key: string): void => {
        this.db.prepare("DELETE FROM extension_state WHERE namespace = ? AND key = ?").run(namespace, key);
      },
      entries: (prefix = ""): Array<{ key: string; value: JsonValue }> => {
        const rows = this.db.prepare(
          "SELECT key, value FROM extension_state WHERE namespace = ? AND key LIKE ? ESCAPE '\\' ORDER BY key",
        ).all(namespace, `${prefix.replace(/[\\%_]/g, "\\$&")}%`) as Array<{ key: string; value: string }>;
        return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) as JsonValue }));
      },
    };
  }
}
