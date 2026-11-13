import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtensionState } from "@mixer/automations-sdk";

const gapSchema = z.object({
  cursor: z.string().min(1),
  oldestAvailable: z.string().nullable(),
  newestAvailable: z.string().nullable(),
  detectedAt: z.string().optional(),
});
const incidentSchema = gapSchema.extend({ repository: z.string().min(1) });
const acknowledgmentSchema = z.object({ acknowledgedAt: z.string(), acknowledgmentReason: z.string().min(1) });
type Incident = z.infer<typeof incidentSchema>;

function incidentId(incident: Incident): string {
  return createHash("sha256").update(JSON.stringify([
    incident.repository, incident.cursor, incident.oldestAvailable, incident.newestAvailable,
  ])).digest("hex");
}

export function readEventGaps(state: ExtensionState) {
  const incidents = new Map<string, Incident>();
  for (const { value } of state.entries("github-event-gap:")) {
    const incident = incidentSchema.parse(value);
    incidents.set(incidentId(incident), incident);
  }
  // Older installations retain only the latest gap and have no detection timestamp.
  for (const { key, value } of state.entries("events:")) {
    if (!key.endsWith(":gap")) continue;
    const incident = { ...gapSchema.parse(value), repository: key.slice("events:".length, -":gap".length) };
    const id = incidentId(incident);
    if (!incidents.has(id)) incidents.set(id, incident);
  }
  return [...incidents].map(([id, incident]) => {
    const stored = state.get(`github-event-gap-ack:${id}`);
    const acknowledgment = stored === undefined ? undefined : acknowledgmentSchema.parse(stored);
    return { id, ...incident, detectedAt: incident.detectedAt ?? null,
      acknowledgedAt: acknowledgment?.acknowledgedAt ?? null, acknowledgmentReason: acknowledgment?.acknowledgmentReason ?? null };
  }).sort((left, right) => (left.detectedAt ?? "").localeCompare(right.detectedAt ?? "") || left.id.localeCompare(right.id));
}

export function recordEventGap(state: ExtensionState, repository: string, gap: z.infer<typeof gapSchema>): void {
  const key = `events:${repository}:gap`;
  const previous = state.get(key);
  if (previous !== undefined) {
    const incident = { ...gapSchema.parse(previous), repository };
    const previousKey = `github-event-gap:${incidentId(incident)}`;
    if (state.get(previousKey) === undefined) state.set(previousKey, incident);
  }
  const incident = { ...gap, repository, detectedAt: new Date().toISOString() };
  const id = incidentId(incident);
  // Retrying the same missing-cursor batch preserves its identity and first detection.
  if (state.get(`github-event-gap:${id}`) === undefined) state.set(`github-event-gap:${id}`, incident);
  state.set(key, gap);
}

export function eventGapsCommand(args: readonly string[], state: ExtensionState): void {
  if (!args.length || (args.length === 1 && args[0] === "--json")) {
    const gaps = readEventGaps(state);
    if (args[0] === "--json") console.log(JSON.stringify(gaps, null, 2));
    else if (!gaps.length) console.log("No GitHub event history gaps recorded.");
    else for (const gap of gaps) {
      console.log(`${gap.id} ${gap.repository} ${gap.acknowledgedAt ? "acknowledged" : "unresolved"}`);
      console.log(`  detected: ${gap.detectedAt ?? "unknown (legacy record)"}; missing cursor: ${gap.cursor}; available: ${gap.oldestAvailable ?? "none"} to ${gap.newestAvailable ?? "none"}`);
      if (gap.acknowledgedAt) console.log(`  acknowledged: ${gap.acknowledgedAt}; reason: ${gap.acknowledgmentReason}`);
    }
    return;
  }
  if (args.length !== 5 || args[0] !== "acknowledge" || args[1] !== "--id" || args[3] !== "--reason") {
    throw new Error("Usage: mixer-automations github gaps [--json] | gaps acknowledge --id ID --reason TEXT");
  }
  const id = z.string().regex(/^[a-f0-9]{64}$/).parse(args[2]);
  const reason = z.string().trim().min(1).max(1_000).parse(args[4]);
  const gap = readEventGaps(state).find(item => item.id === id);
  if (!gap) throw new Error(`Unknown GitHub event history gap: ${id}`);
  if (!gap.acknowledgedAt) {
    // Separate keys prevent acknowledgment from overwriting a concurrently detected gap.
    state.set(`github-event-gap-ack:${id}`, { acknowledgedAt: new Date().toISOString(), acknowledgmentReason: reason });
  }
  console.log(`Acknowledged GitHub event history gap ${id}. Missing events were not recovered; ingestion cursor unchanged.`);
}
