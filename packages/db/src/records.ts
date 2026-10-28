import { createHash } from "node:crypto";
import {
  matchScore, normalizeRef, recordMetrics, recordProblem, recordReadings, MATCH_WINDOW_DAYS, MERGE_SCORE, POSSIBLE_SCORE,
  type DomainRecordInput, type MatchTarget, type MoneyEvidence, type StoredDomainRecord
} from "@crossline/core";
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

/** The person's merchant rules (docs/mail-bookkeeping.md §5.1): a merchant they recategorized once keeps that category. Undoable (`ledger.`). */
export const MERCHANT_RULES_SETTING = "ledger.merchantRules";
export function merchantRules(store: CrosslineStore, workspaceId: string): Record<string, string> {
  try { return JSON.parse(store.getSetting(workspaceId, MERCHANT_RULES_SETTING) ?? "{}") as Record<string, string>; } catch { return {}; }
}

/** `card ••1234`, `paypal`, or "" — the account a payment went through, as far as the evidence says. */
export const accountOf = (evidence: Pick<MoneyEvidence, "instrument" | "last4">) => [evidence.instrument, evidence.last4 ? `••${evidence.last4}` : ""].filter(Boolean).join(" ");

export type MoneyOutcome =
  | { state: "seen" | "attached" | "booked" | "possible_duplicate" | "refund_linked"; record: StoredDomainRecord; score: number }
  | { state: "invalid"; message: string };

const DAY_MS = 86_400_000;
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day.slice(0, 10)}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The wealth records near a day with the evidence behind each, as the matcher reads them. */
function matchTargets(store: CrosslineStore, workspaceId: string, at: string, days: number): Array<{ record: StoredDomainRecord; target: MatchTarget }> {
  const records = store.listRecords(workspaceId, { domain: "wealth", since: shiftDay(at, -days) }).filter((record) => record.at.slice(0, 10) <= shiftDay(at, days));
  const evidence = store.listRecordEvidence(workspaceId, records.map((record) => record.id));
  return records.map((record) => ({ record, target: { kind: record.kind, value: record.value, currency: record.currency, at: record.at, merchantKey: record.merchantKey,
    account: record.account, evidence: evidence.filter((item) => item.recordId === record.id).map((item) => ({ sourceKey: item.sourceKey, role: item.role, senderKey: item.senderKey, refs: item.refs })) } }));
}

/**
 * Keeps one piece of money evidence (docs/mail-bookkeeping.md §4.3), in one transaction: a source item already kept is `seen`; one that
 * scores `MERGE_SCORE` against a record is attached to it; between `POSSIBLE_SCORE` and that, a record of its own waits for the person
 * (`pending_review`, not summed); below, a new record. A refund is linked to the expense it returns (same order number, or the merchant's
 * latest expense within 90 days that is not smaller). The category: the person's rule for the merchant, else what the evidence says.
 * `trusted` (the person's own entry) is booked even when it may duplicate a record.
 */
export function recordMoneyEvidence(store: CrosslineStore, workspaceId: string, ownerId: string, evidence: MoneyEvidence,
  options: { lineId?: string | undefined; today?: string; now?: Date; trusted?: boolean } = {}): MoneyOutcome {
  const now = options.now ?? new Date();
  const problem = recordProblem({ domain: "wealth", kind: evidence.kind, at: evidence.at, value: evidence.value, currency: evidence.currency }, now);
  if (problem) return { state: "invalid", message: problem };
  const outcome = store.atomically((): MoneyOutcome => {
    const known = store.listRecordEvidence(workspaceId).find((item) => item.sourceKey === evidence.sourceKey);
    const knownRecord = known && store.listRecords(workspaceId, { includeDeleted: true }).find((record) => record.id === known.recordId);
    if (knownRecord) return { state: "seen", record: knownRecord, score: 100 };
    const row = (recordId: string) => ({ recordId, source: evidence.source, sourceKey: evidence.sourceKey, sourceRef: evidence.sourceRef, role: evidence.role, kind: evidence.kind,
      amount: evidence.value, currency: evidence.currency, merchant: evidence.merchant, merchantKey: evidence.merchantKey, refs: evidence.refs, last4: evidence.last4,
      instrument: evidence.instrument, occurredOn: evidence.at.slice(0, 10), senderKey: evidence.senderKey });
    let best: { record: StoredDomainRecord; score: number } | undefined;
    for (const { record, target } of matchTargets(store, workspaceId, evidence.at, MATCH_WINDOW_DAYS)) {
      const { score, blocked } = matchScore(evidence, target);
      if (!blocked && score >= POSSIBLE_SCORE && (!best || score > best.score)) best = { record, score };
    }
    if (best && best.score >= MERGE_SCORE) {
      const kept = best.record;
      store.addRecordEvidence(workspaceId, row(kept.id), now.toISOString());
      // A field the record lacks is filled from the new evidence; nothing the record already has is overwritten.
      store.updateRecord(workspaceId, kept.id, { ...(!kept.merchantKey && evidence.merchantKey ? { merchantKey: evidence.merchantKey } : {}),
        ...(!kept.account && accountOf(evidence) ? { account: accountOf(evidence) } : {}),
        ...((!kept.category || kept.category === "其他") && kept.categoryBy !== "person" && evidence.category ? { category: evidence.category, categoryBy: "model" as const } : {}) });
      return { state: "attached", record: store.listRecords(workspaceId).find((record) => record.id === kept.id) ?? kept, score: best.score };
    }
    const rule = evidence.merchantKey ? merchantRules(store, workspaceId)[evidence.merchantKey] : undefined;
    let refundOf = "";
    if (evidence.kind === "refund") {
      const refs = new Set(evidence.refs.map(normalizeRef).filter(Boolean));
      const expenses = matchTargets(store, workspaceId, evidence.at, 90).filter(({ record }) => record.kind === "expense" && record.at.slice(0, 10) <= evidence.at.slice(0, 10)
        && (record.currency || "") === (evidence.currency || "") && record.value + 0.005 >= evidence.value);
      const byRef = expenses.find(({ target }) => target.evidence.some((item) => item.refs.some((ref) => refs.has(normalizeRef(ref)))));
      const byMerchant = evidence.merchantKey ? expenses.filter(({ record }) => record.merchantKey === evidence.merchantKey).at(-1) : undefined;
      refundOf = (byRef ?? byMerchant)?.record.id ?? "";
    }
    const original = refundOf ? store.listRecords(workspaceId).find((record) => record.id === refundOf) : undefined;
    const category = rule ?? (original?.category || evidence.category || (evidence.kind === "income" ? "" : "其他"));
    const categoryBy: StoredDomainRecord["categoryBy"] = rule ? "rule" : original ? original.categoryBy : evidence.category ? "model" : "";
    // What the person typed themselves counts at once: it is never the one put aside as a possible duplicate.
    const possible = best && best.score >= POSSIBLE_SCORE && !options.trusted ? best : undefined;
    const { record } = store.addRecord(workspaceId, { domain: "wealth", kind: evidence.kind, at: evidence.at.slice(0, 10), value: evidence.value, unit: "元",
      currency: evidence.currency, category, note: evidence.note.slice(0, 200), source: evidence.source, sourceRef: evidence.sourceRef, dedupeKey: `txn:${evidence.sourceKey}`,
      merchantKey: evidence.merchantKey, account: accountOf(evidence), categoryBy, status: possible ? "pending_review" : "booked", possibleDupOf: possible?.record.id ?? "", refundOf },
    now.toISOString());
    store.addRecordEvidence(workspaceId, row(record.id), now.toISOString());
    return { state: possible ? "possible_duplicate" : refundOf ? "refund_linked" : "booked", record, score: possible?.score ?? 0 };
  });
  if ((outcome.state === "booked" || outcome.state === "refund_linked") && options.lineId) {
    judgeFromRecords(store, workspaceId, ownerId, "wealth", options.lineId, options.today ?? now.toISOString().slice(0, 10));
  }
  return outcome;
}

/**
 * A failed, cancelled or reversed payment voids the record it matches (a shared order number, or a merge-level score): soft-deleted with the
 * reason, so it can be brought back. Returns the record voided, if any.
 */
export function voidByEvidence(store: CrosslineStore, workspaceId: string, evidence: Omit<MoneyEvidence, "sourceKey" | "source" | "sourceRef" | "note">,
  reason: string, now = new Date()): StoredDomainRecord | undefined {
  const refs = new Set(evidence.refs.map(normalizeRef).filter(Boolean));
  let chosen: StoredDomainRecord | undefined;
  let top = 0;
  for (const { record, target } of matchTargets(store, workspaceId, evidence.at, MATCH_WINDOW_DAYS)) {
    if (record.kind !== "expense" || record.voidReason) continue;
    if (refs.size && target.evidence.some((item) => item.refs.some((ref) => refs.has(normalizeRef(ref))))) { chosen = record; break; }
    const { score, blocked } = matchScore({ ...evidence, kind: "expense", sourceKey: "void" }, target);
    if (!blocked && score >= MERGE_SCORE && score > top) { top = score; chosen = record; }
  }
  if (!chosen) return undefined;
  store.updateRecord(workspaceId, chosen.id, { voidReason: reason.slice(0, 200) });
  store.setRecordDeleted(workspaceId, chosen.id, true, now.toISOString());
  return chosen;
}

/** Two records the person says are one: the evidence moves to `keepId`, the other is removed (kept for undo). */
export function mergeRecords(store: CrosslineStore, workspaceId: string, keepId: string, dropId: string, now = new Date()): boolean {
  if (keepId === dropId) return false;
  const records = store.listRecords(workspaceId);
  if (!records.some((record) => record.id === keepId) || !records.some((record) => record.id === dropId)) return false;
  return store.atomically(() => {
    store.moveRecordEvidence(workspaceId, store.listRecordEvidence(workspaceId, [dropId]).map((item) => item.id), keepId);
    store.updateRecord(workspaceId, dropId, { voidReason: `merged:${keepId}` });
    store.setRecordDeleted(workspaceId, dropId, true, now.toISOString());
    store.updateRecord(workspaceId, keepId, { status: "booked", possibleDupOf: "" });
    return true;
  });
}

/** One piece of evidence taken out of a record it was wrongly merged into, as a record of its own. Returns the new record. */
export function splitRecordEvidence(store: CrosslineStore, workspaceId: string, evidenceId: string, now = new Date()): StoredDomainRecord | undefined {
  const piece = store.listRecordEvidence(workspaceId).find((item) => item.id === evidenceId);
  if (!piece || store.listRecordEvidence(workspaceId, [piece.recordId]).length < 2) return undefined;
  const from = store.listRecords(workspaceId).find((record) => record.id === piece.recordId);
  return store.atomically(() => {
    const { record } = store.addRecord(workspaceId, { domain: "wealth", kind: piece.kind as StoredDomainRecord["kind"], at: piece.occurredOn, value: piece.amount, unit: "元",
      currency: piece.currency, category: from?.category ?? "其他", note: from?.note ?? "", source: piece.source as StoredDomainRecord["source"], sourceRef: piece.sourceRef,
      dedupeKey: `txn:split:${piece.sourceKey}`, merchantKey: piece.merchantKey, account: accountOf({ instrument: piece.instrument as MoneyEvidence["instrument"], last4: piece.last4 }),
      categoryBy: from?.categoryBy ?? "", status: "booked", possibleDupOf: "", refundOf: "" }, now.toISOString());
    store.moveRecordEvidence(workspaceId, [piece.id], record.id);
    return record;
  });
}

/** The person's answer about a possible duplicate: the same one merges it into the record it may duplicate; two different ones both count. */
export function resolvePossibleDuplicate(store: CrosslineStore, workspaceId: string, id: string, same: boolean, now = new Date()): boolean {
  const record = store.listRecords(workspaceId).find((item) => item.id === id && item.status === "pending_review");
  if (!record) return false;
  if (same && record.possibleDupOf && store.listRecords(workspaceId).some((item) => item.id === record.possibleDupOf)) return mergeRecords(store, workspaceId, record.possibleDupOf, id, now);
  return store.updateRecord(workspaceId, id, { status: "booked", possibleDupOf: "" });
}

/** The person changes a record's category; with `everyFromMerchant` the merchant keeps it from now on (a rule) and its other records follow. */
export function setRecordCategory(store: CrosslineStore, workspaceId: string, id: string, category: string, everyFromMerchant: boolean): boolean {
  const record = store.listRecords(workspaceId).find((item) => item.id === id);
  if (!record) return false;
  store.updateRecord(workspaceId, id, { category, categoryBy: "person" });
  if (everyFromMerchant && record.merchantKey) {
    store.setSetting(workspaceId, MERCHANT_RULES_SETTING, JSON.stringify({ ...merchantRules(store, workspaceId), [record.merchantKey]: category }));
    for (const other of store.listRecords(workspaceId, { domain: "wealth" })) {
      if (other.id !== id && other.merchantKey === record.merchantKey && other.categoryBy !== "person") store.updateRecord(workspaceId, other.id, { category, categoryBy: "rule" });
    }
  }
  return true;
}

/** Possible duplicates nobody answered for a week count as two transactions (docs/mail-bookkeeping.md §4.3). Returns how many were settled. */
export function settleStaleDuplicates(store: CrosslineStore, workspaceId: string, now = new Date(), days = 7): number {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  let settled = 0;
  for (const record of store.listRecords(workspaceId, { domain: "wealth" })) {
    if (record.status === "pending_review" && record.createdAt <= cutoff && store.updateRecord(workspaceId, record.id, { status: "booked", possibleDupOf: "" })) settled += 1;
  }
  return settled;
}
