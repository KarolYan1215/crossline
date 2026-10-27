import { createHash } from "node:crypto";
import { recordMetrics, recordProblem, recordReadings, type DomainRecordInput, type StoredDomainRecord } from "@crossline/core";
import type { CrosslineStore } from "./index";

export type RecordOutcome = { ok: true; inserted: boolean; record: StoredDomainRecord } | { ok: false; code: "RECORD_INVALID"; message: string };

/**
 * Keeps one record and reads the domain line's approved milestones against it (docs/domain-lines.md). Every way a record arrives — the
 * input box, a mail, the phone, a confirmed workout — goes through here, so the range check and the milestone reading cannot be skipped.
 * A reading is a `milestone_gate.judged` event with `source: "records"`, beside the gate's and the person's own; one is written only when
 * the readings changed, so a day of small expenses does not repeat the same judgement.
 */
export function recordAndJudge(store: CrosslineStore, workspaceId: string, ownerId: string, input: DomainRecordInput,
  options: { lineId?: string | undefined; today?: string; now?: Date } = {}): RecordOutcome {
  const now = options.now ?? new Date();
  const problem = recordProblem(input, now);
  if (problem) return { ok: false, code: "RECORD_INVALID", message: problem };
  const { inserted, record } = store.addRecord(workspaceId, input, now.toISOString());
  if (inserted && options.lineId) judgeFromRecords(store, workspaceId, ownerId, input.domain, options.lineId, options.today ?? now.toISOString().slice(0, 10));
  return { ok: true, inserted, record };
}

/** Reads every approved milestone of the domain line against this month's and this week's records. Returns how many judgements it wrote. */
export function judgeFromRecords(store: CrosslineStore, workspaceId: string, ownerId: string, domain: DomainRecordInput["domain"], lineId: string, today: string): number {
  // A year back is enough for the latest weight; sums only use the current month and week.
  const since = new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10);
  const metrics = recordMetrics(store.listRecords(workspaceId, { domain, since }), today);
  const latest = new Map<string, ReturnType<CrosslineStore["listMilestones"]>[number]>();
  for (const milestone of store.listMilestones(workspaceId)) if (milestone.identityId === lineId && milestone.status === "approved") latest.set(milestone.id, milestone);
  let written = 0;
  for (const milestone of latest.values()) {
    const readings = recordReadings(domain, milestone.successCriteria, metrics);
    if (!readings.length) continue;
    const hash = createHash("sha256").update(JSON.stringify(readings)).digest("hex").slice(0, 16);
    const { inserted } = store.appendEvent({ ownerId, workspaceId, idempotencyKey: `milestone_gate.judged:records:${milestone.id}:${milestone.version}:${hash}`,
      type: "milestone_gate.judged", entityId: milestone.id,
      payload: { milestoneId: milestone.id, milestoneVersion: milestone.version, verdict: readings.every((item) => item.met === "met") ? "pass" : "partial",
        source: "records", criteriaVerdict: readings } });
    if (inserted) written += 1;
  }
  return written;
}
