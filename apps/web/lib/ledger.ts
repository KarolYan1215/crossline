import "server-only";
import {
  ledgerSummary, monthlyLimitFrom, recurringCharges, spendingAnomalies, INCOME_CATEGORIES, SPEND_CATEGORIES, type AccessContext, type LedgerSummary,
  type RecurringCharge, type SpendingAnomaly, type StoredDomainRecord
} from "@crossline/core";
import { merchantRules, mergeRecords, resolvePossibleDuplicate, setRecordCategory, splitRecordEvidence, MERCHANT_RULES_SETTING } from "@crossline/db";
import { appNow, getStore } from "./crossline";
import { lineOfDomain, personToday } from "./records";

/** One piece of evidence behind a ledger row, as the page shows it. */
export type LedgerEvidence = { id: string; source: string; role: string; at: string; amount: number; merchant: string };
/** One transaction on the ledger page. */
export type LedgerRow = {
  id: string; kind: "income" | "expense" | "refund"; at: string; value: number; currency: string; category: string; categoryBy: string;
  merchant: string; merchantKey: string; account: string; source: string; status: "booked" | "pending_review"; possibleDupOf: string; refundOf: string; note: string;
  evidence: LedgerEvidence[];
};
export type LedgerView = {
  today: string; month: string; months: string[]; hasRecords: boolean;
  summary: LedgerSummary; recurring: RecurringCharge[]; anomalies: SpendingAnomaly[];
  /** This month's transactions, newest first; and the possible duplicates waiting (any month). */
  rows: LedgerRow[]; pending: Array<{ row: LedgerRow; other: LedgerRow | null }>;
  rules: Array<{ merchantKey: string; category: string }>;
  spendCategories: string[]; incomeCategories: string[];
};

const MONEY = new Set(["income", "expense", "refund"]);

/** The wealth line's monthly spending limit from its approved milestones (§5.3), shared with the reports. */
export function ledgerLimit(ctx: AccessContext): number | null {
  const line = lineOfDomain(ctx, "wealth");
  if (!line) return null;
  return monthlyLimitFrom(getStore().listMilestones(ctx.workspaceId).filter((item) => item.identityId === line.id && item.status === "approved").flatMap((item) => item.successCriteria));
}

function rowsOf(ctx: AccessContext, records: StoredDomainRecord[]): LedgerRow[] {
  const evidence = getStore().listRecordEvidence(ctx.workspaceId, records.map((record) => record.id));
  return records.map((record) => {
    const pieces = evidence.filter((item) => item.recordId === record.id);
    return { id: record.id, kind: record.kind as LedgerRow["kind"], at: record.at.slice(0, 10), value: record.value, currency: record.currency || "CNY", category: record.category || "其他",
      categoryBy: record.categoryBy, merchant: pieces.find((item) => item.merchant)?.merchant || record.merchantKey || "", merchantKey: record.merchantKey, account: record.account,
      source: record.source, status: record.status, possibleDupOf: record.possibleDupOf, refundOf: record.refundOf, note: record.note,
      evidence: pieces.map((item) => ({ id: item.id, source: item.source, role: item.role, at: item.occurredOn, amount: item.amount, merchant: item.merchant })) };
  });
}

/** The ledger for one month (docs/mail-bookkeeping.md §5.2), from the money records alone. */
export function loadLedger(ctx: AccessContext, month?: string): LedgerView {
  const store = getStore();
  const today = personToday(ctx);
  const all = store.listRecords(ctx.workspaceId, { domain: "wealth" }).filter((record) => MONEY.has(record.kind));
  const chosen = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const months = [...new Set([today.slice(0, 7), ...all.map((record) => record.at.slice(0, 7))])].sort().reverse();
  const inMonth = all.filter((record) => record.at.slice(0, 7) === chosen).sort((a, b) => b.at.localeCompare(a.at) || b.createdAt.localeCompare(a.createdAt));
  const waiting = all.filter((record) => record.status === "pending_review");
  const byId = new Map(rowsOf(ctx, [...new Map([...inMonth, ...waiting, ...all.filter((record) => waiting.some((item) => item.possibleDupOf === record.id))]
    .map((record) => [record.id, record])).values()]).map((row) => [row.id, row]));
  const summaryDay = chosen === today.slice(0, 7) ? today : new Date(Date.UTC(Number(chosen.slice(0, 4)), Number(chosen.slice(5, 7)), 0)).toISOString().slice(0, 10);
  // Sums are keyed by the merchant's key; the page names each merchant as its own mail or entry wrote it.
  const names = new Map<string, string>();
  for (const item of store.listRecordEvidence(ctx.workspaceId)) if (item.merchantKey && item.merchant && !names.has(item.merchantKey)) names.set(item.merchantKey, item.merchant);
  const named = (key: string) => names.get(key) ?? key;
  const summary = ledgerSummary(all, { today: summaryDay, month: chosen, limit: ledgerLimit(ctx) });
  return {
    today, month: chosen, months, hasRecords: all.length > 0,
    summary: { ...summary, merchants: summary.merchants.map((item) => ({ ...item, merchant: named(item.merchant) })) },
    recurring: recurringCharges(all, today).map((item) => ({ ...item, merchant: named(item.merchant) })),
    anomalies: spendingAnomalies(all, today).map((item) => ({ ...item, merchant: named(item.merchant) })),
    rows: inMonth.map((record) => byId.get(record.id)!),
    pending: waiting.map((record) => ({ row: byId.get(record.id)!, other: byId.get(record.possibleDupOf) ?? null })),
    rules: Object.entries(merchantRules(store, ctx.workspaceId)).map(([merchantKey, category]) => ({ merchantKey, category })),
    spendCategories: [...SPEND_CATEGORIES], incomeCategories: [...INCOME_CATEGORIES]
  };
}

export type LedgerAction =
  | { action: "category"; id: string; category: string; everyFromMerchant: boolean }
  | { action: "merge"; keepId: string; dropId: string }
  | { action: "split"; evidenceId: string }
  | { action: "duplicate"; id: string; same: boolean }
  | { action: "rule_delete"; merchantKey: string };

/** What the ledger page changes; each is undoable through the route's `withUndo`. */
export function applyLedgerAction(ctx: AccessContext, input: LedgerAction): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const now = appNow();
  switch (input.action) {
    case "category": {
      if (![...SPEND_CATEGORIES, ...INCOME_CATEGORIES].includes(input.category as never)) return { ok: false, code: "LEDGER_CATEGORY_UNKNOWN" };
      return setRecordCategory(store, ctx.workspaceId, input.id, input.category, input.everyFromMerchant) ? { ok: true } : { ok: false, code: "RECORD_NOT_FOUND" };
    }
    case "merge": return mergeRecords(store, ctx.workspaceId, input.keepId, input.dropId, now) ? { ok: true } : { ok: false, code: "RECORD_NOT_FOUND" };
    case "split": return splitRecordEvidence(store, ctx.workspaceId, input.evidenceId, now) ? { ok: true } : { ok: false, code: "LEDGER_SPLIT_IMPOSSIBLE" };
    case "duplicate": return resolvePossibleDuplicate(store, ctx.workspaceId, input.id, input.same, now) ? { ok: true } : { ok: false, code: "RECORD_NOT_FOUND" };
    case "rule_delete": {
      const rules = merchantRules(store, ctx.workspaceId);
      if (!(input.merchantKey in rules)) return { ok: false, code: "LEDGER_RULE_NOT_FOUND" };
      delete rules[input.merchantKey];
      store.setSetting(ctx.workspaceId, MERCHANT_RULES_SETTING, JSON.stringify(rules));
      return { ok: true };
    }
  }
}
