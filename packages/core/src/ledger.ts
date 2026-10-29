import type { SuccessCriterion } from "./index";
import type { StoredDomainRecord } from "./records";
import { builtInCategory, INCOME_CATEGORIES, merchantKey, SPEND_CATEGORIES } from "./money-events";

/**
 * The monthly spending limit, when the wealth line has one: the lowest `lte` threshold in a currency (元, CNY, USD …) among its approved
 * milestones' criteria (docs/mail-bookkeeping.md §5.3). There is no budget system of its own.
 */
export function monthlyLimitFrom(criteria: SuccessCriterion[]): number | null {
  const limits = criteria.flatMap((criterion) => criterion.measure.kind === "threshold" && criterion.measure.comparator === "lte"
    && /^(元|cny|rmb|usd|美元|eur|欧元|hkd|cad|gbp)$/i.test(criterion.measure.unit.trim()) ? [criterion.measure.value] : []); // i18n-ignore
  return limits.length ? Math.min(...limits) : null;
}

/**
 * The ledger (docs/mail-bookkeeping.md §5): every booked money record summed by month, day, category, merchant and account, the recurring
 * charges and the unusual ones, and the weekly and monthly reports. All of it from the records alone, by code: no number here is a model's.
 * A refund lowers its category and its day; it is never income. A record waiting on the person's answer (`pending_review`) is listed and not
 * summed. Currencies are kept apart: the main one is this month's most used, the others are totals beside it.
 */
export type LedgerRecord = Pick<StoredDomainRecord, "id" | "kind" | "at" | "value" | "currency" | "category" | "note"> &
  Partial<Pick<StoredDomainRecord, "merchantKey" | "account" | "status" | "refundOf">>;

const round = (value: number) => Math.round(value * 100) / 100;
const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day.slice(0, 10)}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const shiftMonth = (month: string, by: number) => { const at = new Date(`${month}-15T12:00:00Z`); at.setUTCMonth(at.getUTCMonth() + by); return at.toISOString().slice(0, 7); };
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const isMoney = (record: LedgerRecord) => (record.kind === "income" || record.kind === "expense" || record.kind === "refund") && record.status !== "pending_review";
/** What a record does to spending: + for an expense, − for a refund, 0 for income. */
const outflow = (record: LedgerRecord) => record.kind === "expense" ? record.value : record.kind === "refund" ? -record.value : 0;
/** A record's category in the fixed lists: records written before them carry free text (「Apple」), read as the merchant's plain category
 * or 其他 / 其他收入, so the summary never shows a merchant as a category. */
export function ledgerCategory(record: Pick<LedgerRecord, "kind" | "category">): string {
  const fixed: readonly string[] = record.kind === "income" ? INCOME_CATEGORIES : SPEND_CATEGORIES;
  if (fixed.includes(record.category)) return record.category;
  return record.kind === "income" ? "其他收入" : builtInCategory(merchantKey(record.category ?? "")) || "其他";
}
/**
 * A merchant's key for grouping: the record's own, or — for a record written before merchants were kept, whose free-text category was the
 * merchant (「Apple」) — that text keyed the same way, so one shop is one line in 商户前 10 名 (it was 「Apple 12.0」 and 「Apple 3.0」, W-149).
 */
const merchantName = (record: LedgerRecord) => {
  if (record.merchantKey) return record.merchantKey;
  const fixed: readonly string[] = record.kind === "income" ? INCOME_CATEGORIES : SPEND_CATEGORIES;
  if (!record.category || fixed.includes(record.category)) return record.category || "其他";
  return merchantKey(record.category) || record.category;
};

/** The currency most of these records use (CNY with none). */
export function mainCurrency(records: LedgerRecord[]): string {
  const tally = new Map<string, number>();
  for (const record of records) tally.set(record.currency || "CNY", (tally.get(record.currency || "CNY") ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "CNY";
}

export type LedgerSummary = {
  month: string; currency: string;
  spent: number; income: number; net: number; savingsRate: number | null;
  /** Spending to the same day of last month, and the change in percent (null with nothing last month). */
  pace: { day: number; lastMonthToDay: number; changePct: number | null };
  /** Cumulative spending by day of month: this month up to today, last month whole, the average of the three before. */
  cumulative: { thisMonth: number[]; lastMonth: number[]; average3: number[] };
  /** A projection to the month's end at the pace so far (null before the third day). */
  projected: number | null;
  /** The monthly spending limit read from a wealth milestone, when there is one. */
  limit: number | null;
  categories: Array<{ category: string; amount: number; lastMonth: number }>;
  months: Array<{ month: string; income: number; expense: number }>;
  days: Array<{ day: string; amount: number }>;
  merchants: Array<{ merchant: string; amount: number; count: number }>;
  accounts: Array<{ account: string; out: number; in: number }>;
  /** Totals in the other currencies this month. */
  others: Array<{ currency: string; spent: number; income: number }>;
};

/** This month's ledger in the main currency, with last month and the year behind it for comparison. */
export function ledgerSummary(all: LedgerRecord[], options: { today: string; month?: string; currency?: string; limit?: number | null }): LedgerSummary {
  const today = options.today.slice(0, 10);
  const month = options.month ?? today.slice(0, 7);
  const money = all.filter(isMoney);
  const ofMonth = (m: string) => money.filter((record) => record.at.slice(0, 7) === m);
  const currency = options.currency || mainCurrency(ofMonth(month).length ? ofMonth(month) : money);
  const inCur = (records: LedgerRecord[]) => records.filter((record) => (record.currency || "CNY") === currency);
  const current = inCur(ofMonth(month)), last = inCur(ofMonth(shiftMonth(month, -1)));
  const spentOf = (records: LedgerRecord[]) => round(records.reduce((total, record) => total + outflow(record), 0));
  const incomeOf = (records: LedgerRecord[]) => round(records.filter((record) => record.kind === "income").reduce((total, record) => total + record.value, 0));
  const spent = spentOf(current), income = incomeOf(current);
  const isCurrent = month === today.slice(0, 7);
  const dayOfMonth = isCurrent ? Number(today.slice(8, 10)) : daysIn(month);
  const cumulativeOf = (records: LedgerRecord[], m: string, upTo: number) => {
    const byDay = Array.from({ length: daysIn(m) }, () => 0);
    for (const record of records) byDay[Number(record.at.slice(8, 10)) - 1]! += outflow(record);
    let running = 0;
    return byDay.slice(0, upTo).map((value) => round(running += value));
  };
  const lastMonth = shiftMonth(month, -1);
  const lastCumulative = cumulativeOf(last, lastMonth, daysIn(lastMonth));
  const before = [2, 3, 4].map((back) => { const m = shiftMonth(month, -back); return cumulativeOf(inCur(ofMonth(m)), m, daysIn(m)); });
  const average3 = Array.from({ length: daysIn(month) }, (_, index) =>
    round(before.reduce((total, series) => total + (series[Math.min(index, series.length - 1)] ?? 0), 0) / 3));
  const lastToDay = lastCumulative[Math.min(dayOfMonth, lastCumulative.length) - 1] ?? 0;
  const byCategory = (records: LedgerRecord[]) => {
    const map = new Map<string, number>();
    for (const record of records) if (record.kind !== "income") map.set(ledgerCategory(record), (map.get(ledgerCategory(record)) ?? 0) + outflow(record));
    return map;
  };
  const thisCats = byCategory(current), lastCats = byCategory(last);
  const merchants = new Map<string, { amount: number; count: number }>();
  for (const record of current) if (record.kind === "expense") {
    const entry = merchants.get(merchantName(record)) ?? { amount: 0, count: 0 };
    merchants.set(merchantName(record), { amount: entry.amount + record.value, count: entry.count + 1 });
  }
  const accounts = new Map<string, { out: number; in: number }>();
  for (const record of current) {
    const entry = accounts.get(record.account || "") ?? { out: 0, in: 0 };
    if (record.kind === "expense") entry.out += record.value; else entry.in += record.value;
    accounts.set(record.account || "", entry);
  }
  const others = new Map<string, { spent: number; income: number }>();
  for (const record of ofMonth(month)) if ((record.currency || "CNY") !== currency) {
    const entry = others.get(record.currency || "CNY") ?? { spent: 0, income: 0 };
    if (record.kind === "income") entry.income += record.value; else entry.spent += outflow(record);
    others.set(record.currency || "CNY", entry);
  }
  return {
    month, currency, spent, income, net: round(income - spent), savingsRate: income > 0 ? round((1 - spent / income) * 100) : null,
    pace: { day: dayOfMonth, lastMonthToDay: round(lastToDay), changePct: lastToDay > 0 ? round(((spent - lastToDay) / lastToDay) * 100) : null },
    cumulative: { thisMonth: cumulativeOf(current, month, dayOfMonth), lastMonth: lastCumulative, average3 },
    projected: isCurrent && dayOfMonth >= 3 ? round(spent / dayOfMonth * daysIn(month)) : null,
    limit: options.limit ?? null,
    categories: [...new Set([...thisCats.keys(), ...lastCats.keys()])].map((category) => ({ category, amount: round(thisCats.get(category) ?? 0), lastMonth: round(lastCats.get(category) ?? 0) }))
      .filter((item) => item.amount > 0 || item.lastMonth > 0).sort((a, b) => b.amount - a.amount || b.lastMonth - a.lastMonth),
    months: Array.from({ length: 12 }, (_, index) => shiftMonth(month, index - 11)).map((m) => ({ month: m, income: incomeOf(inCur(ofMonth(m))), expense: spentOf(inCur(ofMonth(m))) })),
    days: Array.from({ length: daysIn(month) }, (_, index) => {
      const day = `${month}-${String(index + 1).padStart(2, "0")}`;
      return { day, amount: round(current.filter((record) => record.at.slice(0, 10) === day).reduce((total, record) => total + outflow(record), 0)) };
    }),
    merchants: [...merchants].map(([merchant, entry]) => ({ merchant, amount: round(entry.amount), count: entry.count })).sort((a, b) => b.amount - a.amount).slice(0, 10),
    accounts: [...accounts].map(([account, entry]) => ({ account, out: round(entry.out), in: round(entry.in) })).sort((a, b) => b.out - a.out),
    others: [...others].map(([code, entry]) => ({ currency: code, spent: round(entry.spent), income: round(entry.income) }))
  };
}

export type RecurringCharge = {
  merchant: string; cycle: "weekly" | "monthly" | "yearly"; amount: number; currency: string; annual: number; count: number;
  last: string; next: string; category: string;
  /** The latest charge is over 3% above the one before. */
  priceUp: boolean;
  /** Charged again after more than two cycles without a charge. */
  resumed: boolean;
};
const CYCLES: Array<{ cycle: RecurringCharge["cycle"]; days: number; tolerance: number; min: number; perYear: number }> = [
  { cycle: "weekly", days: 7, tolerance: 2, min: 3, perYear: 52 }, { cycle: "monthly", days: 30.4, tolerance: 4, min: 3, perYear: 12 },
  { cycle: "yearly", days: 365, tolerance: 15, min: 2, perYear: 1 }];

/**
 * Charges that repeat: one merchant, amounts within 10% of the latest, at a weekly, monthly or yearly interval, seen three times (twice for
 * yearly). Reported, never cancelled: nothing in Crossline spends or cancels.
 */
export function recurringCharges(all: LedgerRecord[], today: string): RecurringCharge[] {
  const byMerchant = new Map<string, LedgerRecord[]>();
  for (const record of all) if (record.kind === "expense" && record.status !== "pending_review" && record.merchantKey) {
    byMerchant.set(`${record.merchantKey}|${record.currency || "CNY"}`, [...(byMerchant.get(`${record.merchantKey}|${record.currency || "CNY"}`) ?? []), record]);
  }
  const out: RecurringCharge[] = [];
  for (const records of byMerchant.values()) {
    const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at));
    // Amounts near the merchant's usual one (a price rise of up to 15% stays the same subscription).
    const values = sorted.map((record) => record.value).sort((a, b) => a - b);
    const usual = values[Math.floor(values.length / 2)]!;
    const similar = sorted.filter((record) => Math.abs(record.value - usual) <= usual * 0.15 + 0.01);
    if (!similar.length) continue;
    const latest = similar.at(-1)!;
    for (const { cycle, days, tolerance, min, perYear } of CYCLES) {
      const gaps = similar.slice(1).map((record, index) => (Date.parse(record.at.slice(0, 10)) - Date.parse(similar[index]!.at.slice(0, 10))) / DAY_MS);
      // Gaps of one cycle, or a whole number of cycles (a missed month) when the last gap is a resumption.
      const steady = gaps.filter((gap) => Math.abs(gap - days) <= tolerance);
      if (steady.length + 1 < min) continue;
      const lastGap = gaps.at(-1) ?? 0;
      const previous = similar.at(-2);
      out.push({ merchant: latest.merchantKey!, cycle, amount: latest.value, currency: latest.currency || "CNY", annual: round(latest.value * perYear), count: similar.length,
        last: latest.at.slice(0, 10), next: addDays(latest.at, Math.round(days)), category: ledgerCategory(latest),
        priceUp: Boolean(previous && latest.value > previous.value * 1.03), resumed: lastGap > days * 2 + tolerance });
      break;
    }
  }
  // A charge whose next date is long past (two cycles) has stopped; it is not listed as running.
  return out.filter((item) => Date.parse(today) - Date.parse(item.next) <= (item.cycle === "yearly" ? 60 : item.cycle === "monthly" ? 35 : 10) * DAY_MS)
    .sort((a, b) => b.annual - a.annual);
}

export type SpendingAnomaly = { recordId: string; reason: "large_for_merchant" | "large" | "new_merchant_large"; value: number; at: string; merchant: string };

/** Unusual spending in the last 30 days: over three times the merchant's usual, over the 90 days' 95th percentile, or a large first charge. */
export function spendingAnomalies(all: LedgerRecord[], today: string): SpendingAnomaly[] {
  const expenses = all.filter((record) => record.kind === "expense" && record.status !== "pending_review").sort((a, b) => a.at.localeCompare(b.at));
  const since90 = addDays(today, -90), since30 = addDays(today, -30);
  const recent = expenses.filter((record) => record.at.slice(0, 10) >= since90).map((record) => record.value).sort((a, b) => a - b);
  const p95 = recent.length >= 20 ? recent[Math.floor(recent.length * 0.95)]! : Infinity;
  const out: SpendingAnomaly[] = [];
  for (const record of expenses) {
    if (record.at.slice(0, 10) < since30) continue;
    const earlier = expenses.filter((other) => other.merchantKey && other.merchantKey === record.merchantKey && other.at < record.at).map((other) => other.value).sort((a, b) => a - b);
    const median = earlier.length ? earlier[Math.floor(earlier.length / 2)]! : 0;
    const reason: SpendingAnomaly["reason"] | undefined = earlier.length >= 3 && record.value > median * 3 ? "large_for_merchant"
      : record.value > p95 ? (earlier.length ? "large" : "new_merchant_large") : undefined;
    if (reason) out.push({ recordId: record.id, reason, value: record.value, at: record.at.slice(0, 10), merchant: merchantName(record) });
  }
  return out;
}

export type WeeklyMoneyReport = { start: string; end: string; currency: string; spent: number; average4: number; changePct: number | null;
  top: Array<{ category: string; amount: number }>; largest: { merchant: string; amount: number } | null; newRecurring: RecurringCharge[] };

/** The week from `start` (a Monday) to the Sunday after, against the four weeks before; null when the week has no money record. */
export function weeklyMoneyReport(all: LedgerRecord[], start: string): WeeklyMoneyReport | null {
  const end = addDays(start, 6);
  const money = all.filter(isMoney);
  const within = (from: string, to: string) => money.filter((record) => record.at.slice(0, 10) >= from && record.at.slice(0, 10) <= to);
  const week = within(start, end);
  if (!week.length) return null;
  const currency = mainCurrency(week);
  const inCur = (records: LedgerRecord[]) => records.filter((record) => (record.currency || "CNY") === currency);
  const sum = (records: LedgerRecord[]) => round(inCur(records).reduce((total, record) => total + outflow(record), 0));
  const spent = sum(week);
  const weeks = [1, 2, 3, 4].map((back) => sum(within(addDays(start, -7 * back), addDays(end, -7 * back))));
  const average4 = round(weeks.reduce((a, b) => a + b, 0) / 4);
  const cats = new Map<string, number>();
  for (const record of inCur(week)) if (record.kind !== "income") cats.set(ledgerCategory(record), (cats.get(ledgerCategory(record)) ?? 0) + outflow(record));
  const largest = inCur(week).filter((record) => record.kind === "expense").sort((a, b) => b.value - a.value)[0];
  const newRecurring = recurringCharges(all.filter((record) => record.at.slice(0, 10) <= end), end)
    .filter((item) => item.count === (item.cycle === "yearly" ? 2 : 3) && item.last >= start);
  return { start, end, currency, spent, average4, changePct: average4 > 0 ? round(((spent - average4) / average4) * 100) : null,
    top: [...cats].map(([category, amount]) => ({ category, amount: round(amount) })).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 3),
    largest: largest ? { merchant: merchantName(largest), amount: largest.value } : null, newRecurring };
}

export type MonthlyMoneyReport = { month: string; currency: string; spent: number; income: number; savingsRate: number | null;
  lastMonthSpent: number; changePct: number | null; movers: Array<{ category: string; amount: number; change: number }>;
  subscriptionsAnnual: number; limit: number | null; overLimit: number | null };

/** A finished month against the one before; null when it has no money record. */
export function monthlyMoneyReport(all: LedgerRecord[], month: string, limit: number | null = null): MonthlyMoneyReport | null {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const summary = ledgerSummary(all, { today: last, month, limit });
  if (!all.some((record) => isMoney(record) && record.at.slice(0, 7) === month)) return null;
  const lastMonthSpent = summary.months.at(-2)?.expense ?? 0;
  const recurring = recurringCharges(all.filter((record) => record.at.slice(0, 10) <= last), last).filter((item) => item.currency === summary.currency);
  return { month, currency: summary.currency, spent: summary.spent, income: summary.income, savingsRate: summary.savingsRate, lastMonthSpent,
    changePct: lastMonthSpent > 0 ? round(((summary.spent - lastMonthSpent) / lastMonthSpent) * 100) : null,
    movers: summary.categories.map((item) => ({ category: item.category, amount: item.amount, change: round(item.amount - item.lastMonth) }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 3),
    subscriptionsAnnual: round(recurring.reduce((total, item) => total + item.annual, 0)), limit,
    overLimit: limit !== null ? round(summary.spent - limit) : null };
}

export type LedgerQuery = { month: string; category?: string; merchant?: string; account?: string; kind?: string };
/**
 * The 小帮手's ledger lookup (`ledger_query`, docs/mail-bookkeeping.md §5.3): booked money records of a month by category, merchant and
 * account, summed per currency, with up to thirty of them listed newest first. The answer's numbers are these sums, never the model's.
 */
export function queryLedger(all: LedgerRecord[], filter: LedgerQuery) {
  const merchant = (filter.merchant ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const records = all.filter((record) => isMoney(record) && record.at.slice(0, 7) === filter.month
    && (!filter.category || ledgerCategory(record) === filter.category) && (!filter.account || (record.account ?? "").includes(filter.account))
    && (!merchant || (record.merchantKey ?? "").includes(merchant) || record.note.toLowerCase().replace(/\s+/g, "").includes(merchant))
    && (!filter.kind || (filter.kind === "expense" ? record.kind !== "income" : record.kind === filter.kind)));
  const totals = new Map<string, { spent: number; income: number; count: number }>();
  for (const record of records) {
    const entry = totals.get(record.currency || "CNY") ?? { spent: 0, income: 0, count: 0 };
    if (record.kind === "income") entry.income += record.value; else entry.spent += outflow(record);
    entry.count += 1;
    totals.set(record.currency || "CNY", entry);
  }
  return { month: filter.month, totals: [...totals].map(([currency, entry]) => ({ currency, spent: round(entry.spent), income: round(entry.income), count: entry.count })),
    items: [...records].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((record) => ({ at: record.at.slice(0, 10), kind: record.kind, value: record.value,
      currency: record.currency || "CNY", category: ledgerCategory(record), merchant: record.merchantKey ?? "", account: record.account ?? "" })) };
}
