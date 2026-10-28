import { tFor, type Locale } from "./i18n";
import type { SuccessCriterion } from "./index";

/**
 * Records (docs/domain-lines.md, decided 2026-10-19): the simple bookkeeping of a wealth line and the measurements of a wellness line, one
 * table for both. A record is a fact the person or one of their devices states — a payment, a salary, a workout, a weight — never a model's
 * estimate stored as truth: a model may read one out of a sentence, a mail or a screenshot, but code checks it and the person confirms what
 * they did not type. Records feed the line card's summary and judge a domain milestone's threshold (`recordReadings`).
 */
export const RECORD_KINDS = { wellness: ["workout", "weight", "meal", "metric"], wealth: ["income", "expense", "refund"] } as const;
export type RecordDomain = keyof typeof RECORD_KINDS;
export type RecordKind = (typeof RECORD_KINDS)[RecordDomain][number];
/**
 * Where a record came from. `input` the box, `mail` a bank or shop mail, `phone` a shortcut or a health app, `confirm` a workout block
 * confirmed done, `photo` a screenshot the person confirmed; `csv`, `wearable` and `bank` are reserved for imports not built yet, which go
 * through the same `addRecord` with their own dedupe keys.
 */
export const RECORD_SOURCES = ["input", "mail", "phone", "confirm", "photo", "csv", "wearable", "bank"] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

export type DomainRecordInput = {
  domain: RecordDomain; kind: RecordKind;
  /** `YYYY-MM-DD` or an ISO time: when it happened, in the person's own day. */
  at: string;
  /** Amount (wealth), kilograms (weight), minutes (workout), kilocalories (meal, 0 when unknown), or the metric's value. */
  value: number; unit: string;
  /** ISO 4217 for money (CNY, USD …); empty otherwise. */
  currency: string;
  /** Spending category, workout type, meal or metric name; short. */
  category: string; note: string;
  source: RecordSource; sourceRef: string;
  /** One record per real event: a repeated mail, shortcut or confirmation is the same key and is not written twice. */
  dedupeKey: string;
} & Partial<LedgerFields>;
/**
 * What the ledger keeps beside a money record (docs/mail-bookkeeping.md §4.4, §5.1): the merchant's key and the account it went through,
 * where its category came from (`person` is never overwritten), whether it counts (`pending_review`: maybe a duplicate of `possibleDupOf`,
 * asked about, not summed), the expense a refund belongs to, and why a record was voided.
 */
export type LedgerFields = { merchantKey: string; account: string; categoryBy: "" | "person" | "rule" | "model" | "builtin"; status: "booked" | "pending_review";
  possibleDupOf: string; refundOf: string; voidReason: string };
export type StoredDomainRecord = DomainRecordInput & LedgerFields & { id: string; workspaceId: string; createdAt: string };

const DAY = /^\d{4}-\d{2}-\d{2}/;
const KIND_UNIT: Record<RecordKind, { min: number; max: number }> = {
  income: { min: 0.01, max: 10_000_000 }, expense: { min: 0.01, max: 10_000_000 }, refund: { min: 0.01, max: 10_000_000 },
  weight: { min: 20, max: 300 }, workout: { min: 1, max: 600 }, meal: { min: 0, max: 5000 }, metric: { min: -1_000_000, max: 1_000_000 }
};

/** Why a record cannot be kept, in the person's words, or "" when it can. The model never decides a record is plausible; this does. */
export function recordProblem(input: Pick<DomainRecordInput, "domain" | "kind" | "at" | "value" | "currency">, now = new Date(), locale?: Locale): string {
  const t = tFor(locale);
  if (!(input.domain in RECORD_KINDS)) return t("未知的记录领域");
  if (!(RECORD_KINDS[input.domain] as readonly string[]).includes(input.kind)) return t("这个领域没有这种记录");
  if (!DAY.test(input.at) || Number.isNaN(Date.parse(input.at.slice(0, 10)))) return t("日期无法识别");
  if (Date.parse(input.at.slice(0, 10)) > now.getTime() + 2 * 86_400_000) return t("日期在未来");
  const range = KIND_UNIT[input.kind];
  if (!Number.isFinite(input.value) || input.value < range.min || input.value > range.max) return t("数值超出合理范围");
  if (input.domain === "wealth" && input.currency && !/^[A-Z]{3}$/.test(input.currency)) return t("币种无法识别");
  return "";
}

export type RecordMetrics = {
  /** The current month (by the record's own day), in the currency most of its records use. */
  month: string; currency: string; income: number; expense: number;
  /** 1 − expense / income, as a percentage, when there is income this month. */
  savingsRate: number | null;
  /** Spending by category this month, largest first. */
  categories: Array<{ category: string; amount: number }>;
  /** The last seven days, today included. */
  workouts: number; workoutMinutes: number;
  /** The latest weight on record and its day. */
  weight: { value: number; at: string } | null;
};

type MetricRecord = Pick<DomainRecordInput, "kind" | "at" | "value" | "currency" | "category"> & { status?: string };
/** A record that counts: a possible duplicate waiting for the person's answer does not. */
const counts = (record: { status?: string }) => record.status !== "pending_review";
const isMoney = (record: Pick<DomainRecordInput, "kind"> & { status?: string }) => (record.kind === "income" || record.kind === "expense" || record.kind === "refund") && counts(record);
/** Spending net of refunds: a refund lowers its category and its month, it is never income. */
const spent = (records: MetricRecord[]) => records.reduce((total, record) => total + (record.kind === "expense" ? record.value : record.kind === "refund" ? -record.value : 0), 0);
/** The currency most of these money records use (CNY with none). */
function currencyOf(money: MetricRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of money) counts.set(record.currency || "CNY", (counts.get(record.currency || "CNY") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "CNY";
}

/** What the line card shows and the milestone readings use, computed from the records alone. */
export function recordMetrics(records: MetricRecord[], today: string): RecordMetrics {
  const month = today.slice(0, 7);
  const money = records.filter((record) => isMoney(record) && record.at.slice(0, 7) === month);
  const currency = currencyOf(money);
  const inCurrency = money.filter((record) => (record.currency || "CNY") === currency);
  const income = round(inCurrency.filter((record) => record.kind === "income").reduce((total, record) => total + record.value, 0));
  const expense = round(spent(inCurrency));
  const byCategory = new Map<string, number>();
  for (const record of inCurrency) if (record.kind !== "income") byCategory.set(record.category || "其他", (byCategory.get(record.category || "其他") ?? 0) + (record.kind === "refund" ? -record.value : record.value));
  const weekStart = new Date(Date.parse(today) - 6 * 86_400_000).toISOString().slice(0, 10);
  const workouts = records.filter((record) => record.kind === "workout" && counts(record) && record.at.slice(0, 10) >= weekStart && record.at.slice(0, 10) <= today);
  const weights = records.filter((record) => record.kind === "weight" && counts(record)).sort((a, b) => a.at.localeCompare(b.at));
  const latest = weights.at(-1);
  return { month, currency, income, expense, savingsRate: income > 0 ? round((1 - expense / income) * 100) : null,
    categories: [...byCategory].map(([category, amount]) => ({ category, amount: round(amount) })).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount),
    workouts: workouts.length, workoutMinutes: round(workouts.reduce((total, record) => total + record.value, 0)),
    weight: latest ? { value: latest.value, at: latest.at.slice(0, 10) } : null };
}

const round = (value: number) => Math.round(value * 100) / 100;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Months and weeks the line card's trend covers (docs/domain-lines.md 「主线卡」). */
export const TREND_MONTHS = 6;
export const TREND_WEEKS = 8;
export type RecordTrends = {
  /** The currency the months are summed in: the card's own (this month's most used), else the span's. */
  currency: string;
  /** The last `TREND_MONTHS` months, oldest first, the current one last: income and spending per month, zero where nothing was recorded. */
  months: Array<{ month: string; income: number; expense: number }>;
  /** The last `TREND_WEEKS` weeks, Monday first, oldest first, the current one last: workouts and their minutes, and the week's last weight. */
  weeks: Array<{ start: string; workouts: number; workoutMinutes: number; weight: number | null }>;
};

/** The line card's trend, by month for money and by week for exercise and weight, computed from the records alone. */
export function recordTrends(records: MetricRecord[], today: string, currency = ""): RecordTrends {
  const first = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  const months = Array.from({ length: TREND_MONTHS }, (_, index) => {
    const at = new Date(first); at.setUTCMonth(first.getUTCMonth() - (TREND_MONTHS - 1 - index));
    return at.toISOString().slice(0, 7);
  });
  const money = records.filter((record) => isMoney(record) && months.includes(record.at.slice(0, 7)));
  const chosen = currency || currencyOf(money);
  const inMonth = (month: string) => money.filter((record) => record.at.slice(0, 7) === month && (record.currency || "CNY") === chosen);
  const sum = (month: string, kind: string) => round(kind === "expense" ? spent(inMonth(month))
    : inMonth(month).filter((record) => record.kind === kind).reduce((total, record) => total + record.value, 0));
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const weeks = Array.from({ length: TREND_WEEKS }, (_, index) => addDays(monday, -7 * (TREND_WEEKS - 1 - index))).map((start) => {
    const end = addDays(start, 6);
    const within = (record: MetricRecord) => record.at.slice(0, 10) >= start && record.at.slice(0, 10) <= end;
    const workouts = records.filter((record) => record.kind === "workout" && within(record));
    const weight = records.filter((record) => record.kind === "weight" && within(record)).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    return { start, workouts: workouts.length, workoutMinutes: round(workouts.reduce((total, record) => total + record.value, 0)), weight: weight ? weight.value : null };
  });
  return { currency: chosen, months: months.map((month) => ({ month, income: sum(month, "income"), expense: sum(month, "expense") })), weeks };
}

/**
 * Which of a milestone's criteria the records can judge, and how they stand. Only a threshold whose unit names a measured quantity is
 * read: kilograms (the latest weight), a percentage on a wealth line (this month's savings rate), yuan or another currency with `lte` (this
 * month's spending). A count over weeks, an artifact or a judgement is never read from records: a single week cannot say 「连续八周」.
 */
export function recordReadings(domain: RecordDomain, criteria: SuccessCriterion[], metrics: RecordMetrics, locale?: Locale):
  Array<{ criterionId: string; met: "met" | "unmet"; observed: string }> {
  // `observed` is written into the judgement the milestone page shows, in the workspace's language at the time.
  const t = tFor(locale);
  const readings: Array<{ criterionId: string; met: "met" | "unmet"; observed: string }> = [];
  for (const criterion of criteria) {
    const measure = criterion.measure;
    if (measure.kind !== "threshold") continue;
    const unit = measure.unit.trim().toLowerCase();
    let observed: number | null = null, label = "";
    if (domain === "wellness" && /^(kg|公斤|千克)$/.test(unit) && metrics.weight) { observed = metrics.weight.value; label = t("最近一次体重 {{value}} kg（{{day}}）", { value: observed, day: metrics.weight.at }); }
    if (domain === "wealth" && unit === "%" && metrics.savingsRate !== null) { observed = metrics.savingsRate; label = t("{{month}} 储蓄率 {{value}}%", { month: metrics.month, value: observed }); }
    if (domain === "wealth" && /^(元|cny|rmb|usd|美元|eur|欧元)$/.test(unit) && measure.comparator === "lte" && metrics.expense > 0) {
      observed = metrics.expense; label = t("{{month}} 支出 {{value}} {{currency}}", { month: metrics.month, value: observed, currency: metrics.currency });
    }
    if (observed === null) continue;
    const met = measure.comparator === "lte" ? observed <= measure.value : observed >= measure.value;
    readings.push({ criterionId: criterion.id, met: met ? "met" : "unmet", observed: t("记录：{{label}}", { label }) });
  }
  return readings;
}

/**
 * The amounts a mail's own text states, so a model's reading of a bank alert or receipt is kept only when the text says the same number
 * (it was the model's to classify the mail, never to invent its amount). Matches 「¥35.00」, 「35.00 元」, 「RMB 35」, 「$12.50」, 「USD 12.50」.
 */
export function amountsInText(text: string): Array<{ value: number; currency: string }> {
  const found: Array<{ value: number; currency: string }> = [];
  const number = (raw: string) => Number(raw.replace(/,/g, ""));
  const symbol: Record<string, string> = { "¥": "CNY", "￥": "CNY", "$": "USD", "€": "EUR", "£": "GBP" };
  for (const match of text.matchAll(/([¥￥$€£])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) found.push({ value: number(match[2]!), currency: symbol[match[1]!]! });
  for (const match of text.matchAll(/\b(CNY|RMB|USD|EUR|GBP|HKD)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi)) {
    found.push({ value: number(match[2]!), currency: match[1]!.toUpperCase() === "RMB" ? "CNY" : match[1]!.toUpperCase() });
  }
  // i18n-ignore: currency words read in a mail's own text
  for (const match of text.matchAll(/(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(元|人民币|美元)/g)) found.push({ value: number(match[1]!), currency: match[2] === "美元" ? "USD" : "CNY" });
  return found.filter((item) => Number.isFinite(item.value) && item.value > 0);
}

/** A payment app's notification as a phone forwards it (Android notification relay, MacroDroid, Tasker): its own words, never parsed by a model. */
export type PhoneNotification = { id: string; app: string; title: string; text: string; at: string };
const PAYMENT_WORDS = /支付|付款|消费|扣款|扣费|到账|收款|入账|转入|退款|交易|payment|purchase|charged|received|deposit/i;
const INCOME_WORDS = /到账|收款|入账|转入|工资|退款|received|deposit|refund/i;

/**
 * A wealth record from a payment notification, or why it is not one. Only a notification that names a payment and states exactly one
 * amount becomes a record; anything else (a promotion, a verification code, two amounts) is left out rather than guessed.
 */
export function recordFromNotification(notification: PhoneNotification, today: string):
  { ok: true; record: Omit<DomainRecordInput, "source" | "dedupeKey" | "sourceRef"> } | { ok: false; reason: string } {
  const text = `${notification.title} ${notification.text}`.slice(0, 500);
  if (!PAYMENT_WORDS.test(text)) return { ok: false, reason: "不是付款或到账通知" };
  const amounts = amountsInText(text).filter((item, index, list) => list.findIndex((other) => other.value === item.value && other.currency === item.currency) === index);
  if (amounts.length !== 1) return { ok: false, reason: amounts.length ? "通知里有多个金额" : "通知里没有金额" };
  const day = /^\d{4}-\d{2}-\d{2}/.test(notification.at) ? notification.at.slice(0, 10) : today;
  return { ok: true, record: { domain: "wealth", kind: INCOME_WORDS.test(text) ? "income" : "expense", at: day, value: amounts[0]!.value, unit: "元",
    currency: amounts[0]!.currency, category: "", note: `${notification.app}：${text}`.slice(0, 200) } };
}

/**
 * Wellness records from what a phone posts to /api/health/sleep beside sleep: a shortcut's own `weightKg`, `workouts[]` and `kcal`, or a
 * Health Auto Export payload (`data.metrics[]` with `weight_body_mass` / `dietary_energy`, `data.workouts[]`). Health Auto Export's field
 * names are taken from its public JSON-format page and need checking against a real export; anything unrecognised is ignored, never guessed.
 * Each carries the id it is deduplicated by, so a day posted twice is one set of records.
 */
export function healthRecordsFromPhone(body: Record<string, unknown>, today: string):
  Array<{ id: string; record: Omit<DomainRecordInput, "source" | "dedupeKey" | "sourceRef"> }> {
  const out: Array<{ id: string; record: Omit<DomainRecordInput, "source" | "dedupeKey" | "sourceRef"> }> = [];
  const dayOf = (value: unknown) => typeof value === "string" && DAY.test(value) ? value.slice(0, 10) : today;
  const num = (value: unknown) => typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  const weight = (at: string, kg: number) => { if (Number.isFinite(kg)) out.push({ id: `weight:${at}`, record: { domain: "wellness", kind: "weight", at, value: Math.round(kg * 10) / 10, unit: "kg", currency: "", category: "体重", note: "" } }); };
  const workout = (id: string, at: string, minutes: number, type: string) => {
    if (Number.isFinite(minutes) && minutes > 0) out.push({ id: `workout:${id}`, record: { domain: "wellness", kind: "workout", at, value: Math.round(minutes), unit: "分钟", currency: "", category: type.slice(0, 40), note: "" } });
  };
  const meal = (at: string, kcal: number) => { if (Number.isFinite(kcal)) out.push({ id: `meal:${at}`, record: { domain: "wellness", kind: "meal", at, value: Math.round(kcal), unit: "千卡", currency: "", category: "全天摄入", note: "" } }); };
  const day = dayOf(body.day);
  if (body.weightKg !== undefined) weight(day, num(body.weightKg));
  if (body.kcal !== undefined) meal(day, num(body.kcal));
  for (const item of (Array.isArray(body.workouts) ? body.workouts : []).slice(0, 20) as Array<Record<string, unknown>>) {
    const start = typeof item?.start === "string" ? item.start : "";
    workout(String(item?.id ?? start ?? ""), dayOf(start || item?.day), num(item?.minutes), String(item?.type ?? item?.name ?? "运动"));
  }
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  for (const metric of (Array.isArray(data.metrics) ? data.metrics : []) as Array<Record<string, unknown>>) {
    const points = (Array.isArray(metric?.data) ? metric.data : []) as Array<Record<string, unknown>>;
    for (const point of points.slice(-14)) {
      const at = dayOf(point?.date), qty = num(point?.qty);
      if (metric.name === "weight_body_mass") weight(at, String(metric.units ?? "kg").toLowerCase().startsWith("lb") ? qty * 0.453592 : qty);
      if (metric.name === "dietary_energy") meal(at, String(metric.units ?? "kcal").toLowerCase() === "kj" ? qty / 4.184 : qty);
    }
  }
  for (const item of (Array.isArray(data.workouts) ? data.workouts : []).slice(0, 20) as Array<Record<string, unknown>>) {
    const start = typeof item?.start === "string" ? item.start : "";
    // A duration in seconds (no workout lasts 600 minutes); the export has used both.
    const raw = num(item?.duration);
    workout(String(item?.id ?? start), dayOf(start), raw > 600 ? raw / 60 : raw, String(item?.name ?? "运动"));
  }
  return out;
}
