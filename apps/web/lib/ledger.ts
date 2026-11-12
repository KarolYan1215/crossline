import "server-only";
import {
  budgetLines, budgetPace, convertRecords, ledgerCategory, ledgerSummary, monthlyCap, monthlyLimitFrom, recurringCharges, spendingAnomalies, FX_CURRENCIES, INCOME_CATEGORIES, SPEND_CATEGORIES,
  type AccessContext, type Budget, type BudgetLine, type BudgetPace, type Converter, type LedgerSummary, type RecurringCharge, type SpendingAnomaly, type StoredDomainRecord
} from "@crossline/core";
import { merchantRules, mergeRecords, resolvePossibleDuplicate, setRecordCategory, splitRecordEvidence, MERCHANT_RULES_SETTING } from "@crossline/db";
import { appNow, getStore } from "./crossline";
import { lineOfDomain, personToday } from "./records";
import { baseCurrency, budgetOf, fxConverter, spendingOnly } from "./wealth";

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
  /** Totals are in `base`, each record converted at its own day's rate; `rateDay`: the latest rate used ("" when nothing needed one). */
  fx: { base: string; rateDay: string; currencies: string[] };
  /**
   * The capped categories against the month (docs/ledger-wealth.md §3.4); `limitFrom` says whose monthly cap it is; `monthly`: the month's
   * spending against that cap, in the base currency; `unconverted`: the person's cap is in a currency with no rate yet, so it is not compared.
   */
  budget: { lines: BudgetLine[]; limitFrom: "person" | "milestone" | null; own: Budget; monthly: BudgetPace | null; unconverted: boolean };
  /** 「只记开销」: the person keeps spending only, so no income figure is shown whatever was booked. */
  spendingOnly: boolean;
};

const MONEY = new Set(["income", "expense", "refund"]);

/**
 * The monthly spending limit in the base currency: the person's own budget cap (docs/ledger-wealth.md §3.4) when set, at `day`'s rate (null
 * while its currency has no rate), else the wealth line's approved milestones (§5.3), shared with the reports.
 */
export function ledgerLimit(ctx: AccessContext, base: string, fx: Converter, day: string): number | null {
  const own = budgetOf(ctx);
  if (own.monthly !== null) return monthlyCap(own, base, fx, day);
  return milestoneLimit(ctx);
}

function milestoneLimit(ctx: AccessContext): number | null {
  const line = lineOfDomain(ctx, "wealth");
  if (!line) return null;
  return monthlyLimitFrom(getStore().listMilestones(ctx.workspaceId).filter((item) => item.identityId === line.id && item.status === "approved").flatMap((item) => item.successCriteria));
}

function rowsOf(ctx: AccessContext, records: StoredDomainRecord[]): LedgerRow[] {
  const evidence = getStore().listRecordEvidence(ctx.workspaceId, records.map((record) => record.id));
  return records.map((record) => {
    const pieces = evidence.filter((item) => item.recordId === record.id);
    return { id: record.id, kind: record.kind as LedgerRow["kind"], at: record.at.slice(0, 10), value: record.value, currency: record.currency || "CNY", category: ledgerCategory(record),
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
  // One currency for the totals (docs/ledger-wealth.md §3): each record at its own day's rate; one with no rate stays beside them.
  const base = baseCurrency(ctx).code;
  const fx = fxConverter();
  const converted = convertRecords(all, base, fx);
  const limit = ledgerLimit(ctx, base, fx, summaryDay);
  const only = spendingOnly(ctx);
  const summary = ledgerSummary(converted.records, { today: summaryDay, month: chosen, currency: base, limit, spendingOnly: only });
  const isCurrent = chosen === today.slice(0, 7);
  const daysInMonth = new Date(Date.UTC(Number(chosen.slice(0, 4)), Number(chosen.slice(5, 7)), 0)).getUTCDate();
  const own = budgetOf(ctx);
  return {
    today, month: chosen, months, hasRecords: all.length > 0,
    summary: { ...summary, merchants: summary.merchants.map((item) => ({ ...item, merchant: named(item.merchant) })) },
    recurring: recurringCharges(all, today).map((item) => ({ ...item, merchant: named(item.merchant) })),
    anomalies: spendingAnomalies(all, today).map((item) => ({ ...item, merchant: named(item.merchant) })),
    rows: inMonth.map((record) => byId.get(record.id)!),
    pending: waiting.map((record) => ({ row: byId.get(record.id)!, other: byId.get(record.possibleDupOf) ?? null })),
    rules: Object.entries(merchantRules(store, ctx.workspaceId)).map(([merchantKey, category]) => ({ merchantKey, category })),
    spendCategories: [...SPEND_CATEGORIES], incomeCategories: [...INCOME_CATEGORIES],
    fx: { base, rateDay: converted.rateDay, currencies: [...FX_CURRENCIES] },
    budget: { lines: budgetLines(own, summary.categories, summary.pace.day, daysInMonth, isCurrent, summary.spendDays),
      limitFrom: limit === null ? null : own.monthly !== null ? "person" : "milestone", own,
      monthly: limit === null ? null : budgetPace(summary.spent, limit, summary.pace.day, daysInMonth, isCurrent), unconverted: own.monthly !== null && limit === null },
    spendingOnly: only
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
