import { createHash, randomBytes } from "node:crypto";
import { toJSONSchema, z } from "zod";
import type {
  Event, EventActivation, HookContext, Logger, MaintainerCommunication, Run, SafeActionContext, SafeActionPrepareContext, SafeActionDefinition, SafeActionPolicy, SafeActionResult, SafeActionTool,
  VerificationResult, Workflow, Workspace, WorkspaceArtifact,
} from "@mixer/automations-sdk";
import type { ActionEffectRecord, ActionPlanRecord, RunLease, StateDatabase } from "./database.js";
import type { Registry } from "./registry.js";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const actionRequestSchema = z.object({
  name: z.string().min(1).max(200), input: z.json(), requestKey: z.string().min(1).max(200),
}).strict();

export class SafeActionGate {
  constructor(
    private readonly registry: Registry,
    private readonly database: StateDatabase,
    private readonly dryRun: boolean,
  ) {}

  private readonly closedRuns = new Set<string>();

  close(runId: string): void {
    this.closedRuns.add(runId);
  }

  reopen(runId: string): void {
    this.closedRuns.delete(runId);
  }

  tools(context: { run: Run; event: Event; workflow: Workflow; workspace?: Workspace; logger: Logger }): SafeActionTool[] {
    return Object.keys(context.workflow.safeActions).flatMap((name) => {
      const definition = this.registry.actionDefinitions.get(name);
      if (!definition) return [];
      return [{
        name,
        description: definition.description,
        inputSchema: toJSONSchema(definition.schema) as Record<string, unknown>,
        request: (input: unknown) => this.request(name, input, context),
      }];
    });
  }

  async request(
    actionName: string,
    payload: unknown,
    context: { run: Run; event: Event; workflow: Workflow; workspace?: Workspace; logger: Logger },
  ): Promise<SafeActionResult> {
    const actionId = id("act");
    const createdAt = new Date().toISOString();
    this.database.insertAction({ id: actionId, runId: context.run.id, action: actionName, payload, status: "requested", createdAt });
    const reject = (reason: string): SafeActionResult => {
      this.database.updateAction(actionId, "rejected", reason);
      return { id: actionId, status: "rejected", reason };
    };
    const definition = this.registry.actionDefinitions.get(actionName);
    if (this.closedRuns.has(context.run.id)) return reject("safe_action_phase_closed");
    if (!definition) return reject("safe_action_not_registered");
    const rawPolicy = context.workflow.safeActions[actionName];
    if (!rawPolicy) return reject("safe_action_not_allowed");
    const input = definition.schema.safeParse(payload);
    if (!input.success) return reject("safe_action_schema_invalid");
    const policy = definition.policySchema?.safeParse(rawPolicy);
    if (policy && !policy.success) return reject("safe_action_policy_invalid");
    const validatedPolicy = (policy?.data ?? rawPolicy) as SafeActionPolicy;
    if (this.database.countAcceptedActions(context.run.id, actionName) >= validatedPolicy.max) {
      return reject("safe_action_limit_exceeded");
    }

    this.database.updateAction(actionId, "proposed");
    const hook: HookContext = { event: context.event, run: context.run, workspace: context.workspace, instructions: [], metadata: {} };
    await this.registry.runHooks("safe-action:before", hook);
    if (hook.cancelled) return reject(hook.reason ?? "safe_action_cancelled_by_hook");
    context.logger.info({ action: actionName, payload }, "Safe Action proposal recorded");
    return { id: actionId, status: "proposed" };
  }

  requestScripted(actionName: string, payload: unknown,
    context: { run: Run; workflow: Workflow; logger: Logger },
    scope: { lease: RunLease; stepId: string; attempt: number; key: string }): SafeActionResult {
    const definition = this.registry.actionDefinitions.get(actionName);
    const rawPolicy = context.workflow.safeActions[actionName];
    const policy = definition?.policySchema?.safeParse(rawPolicy);
    const reason = this.closedRuns.has(context.run.id) ? "safe_action_phase_closed"
      : !definition ? "safe_action_not_registered"
      : !rawPolicy ? "safe_action_not_allowed"
      : !definition.schema.safeParse(payload).success ? "safe_action_schema_invalid"
      : policy && !policy.success ? "safe_action_policy_invalid" : undefined;
    const hash = createHash("sha256").update(stable({ action: actionName, payload })).digest("hex");
    const record = this.database.admitActionRequest(scope.lease, scope.stepId, scope.attempt, scope.key, hash, {
      id: id("act"), runId: context.run.id, action: actionName, payload,
      status: reason ? "rejected" : "proposed", reason, createdAt: new Date().toISOString(),
    });
    context.logger.info({ action: actionName, actionId: record.id, status: record.status, reason: record.reason }, "Scripted Safe Action request recorded");
    return { id: record.id, status: record.status, ...(record.reason ? { reason: record.reason } : {}) };
  }

  /** Validate and apply actions only after workflow execution has stopped. */
  async apply(context: {
    run: Run; event: Event; workflow: Workflow; workspace?: Workspace; logger: Logger;
    artifact?: WorkspaceArtifact; verification?: readonly VerificationResult[]; activation?: EventActivation;
    communication?: MaintainerCommunication;
    signal?: AbortSignal; deadline?: string; assertActive?: () => void;
  }): Promise<SafeActionResult[]> {
    const records = this.database.listActions(context.run.id).filter((record) => record.status === "proposed");
    if (!records.length) return [];
    if (records.length > 1) {
      for (const record of records) this.database.updateAction(record.id, "rejected", "safe_action_plan_multiple_effects");
      return records.map((record) => ({ id: record.id, status: "rejected", reason: "safe_action_plan_multiple_effects" }));
    }
    const prepared: Array<{ record: typeof records[number]; definition: SafeActionDefinition; policy: SafeActionPolicy; value: unknown }> = [];
    for (const record of records) {
      const definition = this.registry.actionDefinitions.get(record.action);
      if (!definition) {
        for (const item of records) this.database.updateAction(item.id, "rejected", "safe_action_not_registered");
        return records.map((item) => ({ id: item.id, status: "rejected", reason: "safe_action_not_registered" }));
      }
      const policyResult = definition.policySchema?.safeParse(context.workflow.safeActions[record.action]);
      const inputResult = definition.schema.safeParse(record.payload);
      if (!inputResult.success || (policyResult && !policyResult.success)) {
        this.database.updateAction(record.id, "rejected", "safe_action_plan_validation_failed");
        for (const other of records) if (other.id !== record.id) this.database.updateAction(other.id, "rejected", "safe_action_plan_validation_failed");
        return records.map((item) => ({ id: item.id, status: "rejected", reason: "safe_action_plan_validation_failed" }));
      }
      try {
        context.assertActive?.();
        const actionContext: SafeActionPrepareContext = {
          run: context.run, event: context.event, repository: context.run.repository,
          workspace: context.workspace, policy: (policyResult?.data ?? context.workflow.safeActions[record.action]) as SafeActionPolicy,
          logger: context.logger, artifact: context.artifact, verification: context.verification,
          activation: context.activation, communication: context.communication,
          workflow: context.workflow,
          signal: context.signal, deadline: context.deadline,
        };
        const value = await definition.prepare(actionContext, inputResult.data);
        const hook: HookContext = { event: context.event, run: context.run, workspace: context.workspace, instructions: [], metadata: {} };
        await this.registry.runHooks("safe-action:before", hook);
        if (hook.cancelled) throw new Error(hook.reason ?? "safe_action_cancelled_by_hook");
        context.assertActive?.();
        prepared.push({ record, definition, policy: actionContext.policy, value });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const item of records) this.database.updateAction(item.id, "rejected", reason);
        return records.map((item) => ({ id: item.id, status: "rejected", reason }));
      }
    }
    if (!prepared.length) return records.map((item) => ({ id: item.id, status: "rejected", reason: "safe_action_plan_validation_failed" }));
    context.assertActive?.();
    const plan = { version: 1, runId: context.run.id, actions: prepared.map(({ record, value }) => ({ id: record.id, action: record.action, payload: record.payload, prepared: value })) };
    const hash = createHash("sha256").update(stable(plan)).digest("hex");
    const planId = id("plan");
    const effects = prepared.map((item, ordinal) => ({ id: id("effect"), item, ordinal }));
    this.database.insertPlan({ id: planId, runId: context.run.id, plan, hash, status: this.dryRun ? "staged" : "validated", createdAt: new Date().toISOString() },
      effects.map(effect => ({ id: effect.id, ordinal: effect.ordinal, idempotencyKey: `${hash}:${effect.ordinal}`, prepared: effect.item.value })));
    if (this.dryRun) {
      for (const item of prepared) this.database.updateAction(item.record.id, "staged");
      return prepared.map(({ record }) => ({ id: record.id, status: "staged" }));
    }
    this.database.updatePlan(planId, "applying");
    const results: SafeActionResult[] = [];
    for (const effect of effects) {
      const item = effect.item;
      this.database.updateEffect(effect.id, "executing");
      this.database.updateAction(item.record.id, "validated");
      try {
        context.assertActive?.();
        const actionContext: SafeActionContext = {
          run: context.run, event: context.event, repository: context.run.repository,
          workspace: context.workspace, policy: item.policy, logger: context.logger,
          artifact: context.artifact, verification: context.verification, communication: context.communication,
          signal: context.signal, deadline: context.deadline,
          operation: { version: 1, actionId: item.record.id, planId, effectId: effect.id, idempotencyKey: `${hash}:${effect.ordinal}`, attempt: 1, reconciliation: false },
        };
        const result = await item.definition.executePrepared!(actionContext, item.value);
        this.database.updateEffect(effect.id, "executed", result);
        this.database.updateAction(item.record.id, "executed", undefined, result);
        results.push({ id: item.record.id, status: "executed", result });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.database.updateEffect(effect.id, "failed", undefined, reason);
        this.database.updateAction(item.record.id, "failed", reason);
        results.push({ id: item.record.id, status: "failed", reason });
      }
    }
    this.database.updatePlan(planId, results.some((result) => result.status === "failed" || result.status === "rejected") ? "failed" : "completed");
    return results;
  }

  /** Resume a persisted, immutable action plan after an unexpected daemon stop. */
  async reconcile(context: {
    run: Run; event: Event; workflow: Workflow; workspace?: Workspace; logger: Logger;
    artifact?: WorkspaceArtifact; verification?: readonly VerificationResult[];
    signal?: AbortSignal; deadline?: string;
  }, plan: ActionPlanRecord, effects: readonly ActionEffectRecord[]): Promise<SafeActionResult[]> {
    const snapshot = plan.plan as { actions?: Array<{ id?: string; action?: string }> };
    if (!Array.isArray(snapshot.actions)) throw new Error("safe_action_recovery_plan_invalid");
    this.database.updatePlan(plan.id, "applying");
    const results: SafeActionResult[] = [];
    for (const effect of effects) {
      const action = snapshot.actions[effect.ordinal];
      if (!action?.id || !action.action) throw new Error("safe_action_recovery_effect_invalid");
      const definition = this.registry.actionDefinitions.get(action.action);
      if (!definition?.executePrepared) throw new Error(`safe_action_recovery_definition_unavailable:${action.action}`);
      const policyResult = definition.policySchema?.safeParse(context.workflow.safeActions[action.action]);
      if (policyResult && !policyResult.success) throw new Error(`safe_action_recovery_policy_invalid:${action.action}`);
      this.database.updateEffect(effect.id, "executing");
      this.database.updateAction(action.id, "validated", "reconciling_after_restart");
      try {
        if (effect.status === "pending") {
          context.signal?.throwIfAborted();
          if (context.deadline && Date.now() >= Date.parse(context.deadline)) throw new Error("safe_action_deadline_exceeded");
        }
        const result = await definition.executePrepared({
          run: context.run,
          event: context.event,
          repository: context.run.repository,
          workspace: context.workspace,
          policy: (policyResult?.data ?? context.workflow.safeActions[action.action]) as SafeActionPolicy,
          logger: context.logger,
          artifact: context.artifact,
          verification: context.verification,
          signal: context.signal, deadline: context.deadline,
          operation: { version: 1, actionId: action.id, planId: plan.id, effectId: effect.id, idempotencyKey: effect.idempotencyKey, attempt: effect.attempts + 1, reconciliation: true },
        }, effect.prepared);
        this.database.updateEffect(effect.id, "executed", result);
        this.database.updateAction(action.id, "executed", undefined, result);
        results.push({ id: action.id, status: "executed", result });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.database.updateEffect(effect.id, "failed", undefined, reason);
        this.database.updateAction(action.id, "failed", reason);
        results.push({ id: action.id, status: "failed", reason });
      }
    }
    this.database.updatePlan(plan.id, results.some((result) => result.status === "failed") ? "failed" : "completed");
    return results;
  }
}
