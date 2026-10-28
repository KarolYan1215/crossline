import "server-only";
import { randomUUID } from "node:crypto";
import { recordAndJudge, recordMoneyEvidence, type RecordOutcome } from "@crossline/db";
import {
  healthRecordsFromPhone, merchantKey, recordMetrics, recordTrends, type AccessContext, type DomainRecordInput, type RecordDomain, type RecordMetrics, type RecordTrends,
  type StoredDomainRecord
} from "@crossline/core";
import { DOMAIN_PACKS, LINE_DOMAINS } from "@crossline/identity-packs";
import { formatInTimeZone } from "date-fns-tz";
import { appNow, effectiveSchedulePreferences, getStore } from "./crossline";
import { identityLines } from "./lines";

/** The person's own day, so this month and this week end where theirs do. */
export const personToday = (ctx: AccessContext) => formatInTimeZone(appNow(), effectiveSchedulePreferences(ctx).preferences.timeZone, "yyyy-MM-dd");

/** The live line of a domain, if the workspace has one: its milestones are what records judge. */
export const lineOfDomain = (ctx: AccessContext, domain: RecordDomain) => identityLines(ctx).find((line) => line.domain === domain);

/**
 * Keeps one record for this workspace (docs/domain-lines.md): checked, written once per `dedupeKey`, then read against the domain line's
 * approved milestones. Without a `dedupeKey` the record is the person's own entry and gets a fresh one.
 */
export function addDomainRecord(ctx: AccessContext, input: Omit<DomainRecordInput, "dedupeKey"> & { dedupeKey?: string; merchant?: string; app?: string }): RecordOutcome {
  const dedupeKey = input.dedupeKey || `${input.source}:${randomUUID()}`;
  const options = { lineId: lineOfDomain(ctx, input.domain)?.id, today: personToday(ctx), now: appNow() };
  // Money goes through the ledger's matcher (docs/mail-bookkeeping.md §4.3): the phone's notification and the bank's mail of one payment
  // are one record. The person's own entry is booked at once (`trusted`); a phone's may wait as a possible duplicate.
  if (input.domain === "wealth" && (input.source === "input" || input.source === "phone" || input.source === "photo")) {
    const merchant = (input.merchant ?? "").trim();
    const outcome = recordMoneyEvidence(getStore(), ctx.workspaceId, ctx.principalId, { sourceKey: dedupeKey, source: input.source, sourceRef: input.sourceRef,
      kind: input.kind as "expense" | "income" | "refund", value: input.value, currency: input.currency || "CNY", at: input.at.slice(0, 10), merchant,
      merchantKey: merchantKey(merchant), category: input.category, refs: [], last4: "", instrument: "", role: input.source, senderKey: (input.app ?? "").toLowerCase().slice(0, 40),
      note: input.note }, { ...options, trusted: input.source === "input" });
    if (outcome.state === "invalid") return { ok: false, code: "RECORD_INVALID", message: outcome.message };
    return { ok: true, inserted: outcome.state !== "seen" && outcome.state !== "attached", record: outcome.record };
  }
  return recordAndJudge(getStore(), ctx.workspaceId, ctx.principalId, { ...input, dedupeKey }, options);
}

export function removeDomainRecord(ctx: AccessContext, id: string): { ok: true } | { ok: false; code: string } {
  return getStore().setRecordDeleted(ctx.workspaceId, id, true) ? { ok: true } : { ok: false, code: "RECORD_NOT_FOUND" };
}

export type DomainRecordsView = { domain: RecordDomain; label: string; lineId: string | null; metrics: RecordMetrics; trends: RecordTrends; recent: StoredDomainRecord[] };

/** Each domain's numbers for the line card and the records drawer: this month's money, this week's workouts, the latest weight, and the trend behind them. */
export function domainRecordViews(ctx: AccessContext): DomainRecordsView[] {
  const store = getStore();
  const today = personToday(ctx);
  const since = new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10);
  return LINE_DOMAINS.flatMap((domain) => {
    const records = store.listRecords(ctx.workspaceId, { domain, since });
    const line = lineOfDomain(ctx, domain);
    if (!line && !records.length) return [];
    const metrics = recordMetrics(records, today);
    return [{ domain, label: DOMAIN_PACKS[domain].label, lineId: line?.id ?? null, metrics, trends: recordTrends(records, today, metrics.currency), recent: records.slice(-30).reverse() }];
  });
}

/**
 * The wellness records a phone sent beside its sleep (/api/health/sleep), written as the workspace's owner: a device token has no session,
 * and the records are the person's own measurements.
 */
export function storePhoneHealthRecords(workspaceId: string, body: Record<string, unknown>): number {
  const ownerId = getStore().getWorkspaceOwnerId(workspaceId);
  if (!ownerId) return 0;
  const ctx: AccessContext = { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-device", subject: ownerId },
    authMethod: "device-token", requestId: `health-records:${Date.now()}` };
  let stored = 0;
  for (const { id, record } of healthRecordsFromPhone(body, personToday(ctx))) {
    const result = addDomainRecord(ctx, { ...record, source: "phone", sourceRef: id, dedupeKey: `phone:${id}` });
    if (result.ok && result.inserted) stored += 1;
  }
  return stored;
}
