import { quoteSupportsDate } from "./date-schema";

/**
 * Bookkeeping from mail and the other money sources (docs/mail-bookkeeping.md, 2026-10-28). A mail about money is one event of a closed
 * list, read by the triage model; only an event where money actually moved is booked (`BOOKABLE_EVENTS`). Code then checks what the model
 * read against the mail's own text — the amount where it stands, the order numbers and card digits verbatim, the day — and a veto list on
 * the subject and the amount's line keeps a request, a hold, a statement or a failure out whatever the model said. Every piece that
 * survives is evidence of one real transaction; `matchScore` decides whether two pieces are the same one.
 */
export const MONEY_EVENTS = ["", "charge", "receipt", "refund", "income", "authorization", "own_transfer", "statement", "request", "failed", "alert", "upcoming"] as const;
export type MoneyEvent = (typeof MONEY_EVENTS)[number];
export const BOOKABLE_EVENTS: readonly MoneyEvent[] = ["charge", "receipt", "refund", "income"];
export const MONEY_INSTRUMENTS = ["", "card", "paypal", "alipay", "wechat", "bank", "apple", "google"] as const;
export type MoneyInstrument = (typeof MONEY_INSTRUMENTS)[number];

/** Spending categories, fixed so months compare (keys; translated where shown). */
export const SPEND_CATEGORIES = ["餐饮", "买菜日用", "交通", "住房水电", "订阅与软件", "购物", "医疗健康", "教育", "娱乐", "旅行", "人情与转给他人", "其他"] as const;
export const INCOME_CATEGORIES = ["工资", "转入", "其他收入"] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** What the triage model reads out of a money mail, every field as the mail shows it; `event` "" when the mail is not about money. */
export type MoneyReading = {
  event: MoneyEvent; amount: number; amountLabel: string; currency: string; merchant: string; category: string;
  occurredOn: string; refs: string[]; last4: string; instrument: MoneyInstrument;
};
export const EMPTY_MONEY_READING: MoneyReading = { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" };

/** One piece of evidence of a transaction, checked and ready for the ledger (`recordMoneyEvidence` in packages/db). */
export type MoneyEvidence = {
  /** Unique per source item: a mail's Message-ID hash, a notification's id, an input's own id. Seen twice, it is the same evidence. */
  sourceKey: string; source: "mail" | "phone" | "input" | "photo"; sourceRef: string;
  kind: "expense" | "income" | "refund"; value: number; currency: string; at: string;
  merchant: string; merchantKey: string; category: string; refs: string[]; last4: string; instrument: MoneyInstrument;
  /** The event it came from (`charge`, `receipt` …, or the source's own role: `phone`, `input`). */
  role: string;
  /** Who sent it: the sender's domain for mail, the app for a notification. Two pieces of one role from one sender are two transactions. */
  senderKey: string; note: string;
};

export type MoneyVerdict =
  | { book: true; evidence: Omit<MoneyEvidence, "sourceKey" | "source" | "sourceRef" | "note"> }
  /** `voids`: a failure, cancellation or reversal whose evidence may match a record already booked. */
  | { book: false; reason: "not_money" | "not_booked" | "vetoed" | "amount_unverified"; event: MoneyEvent; voids?: Omit<MoneyEvidence, "sourceKey" | "source" | "sourceRef" | "note"> };

// Words in a mail's own text, matched, never shown.
/* i18n-ignore-start */
const VETO = /\brequest(?:ed|s)?\b|\bexpir(?:ed|es|y)\b|\bdeclined\b|\bfail(?:ed|ure)?\b|\bcancel(?:l?ed|lation)?\b|\brevers(?:ed|al)\b|\bpending\b|\b(?:pre-?)?authori[sz](?:ation|ed)\b|\bhold\b|\bstatement\b|\bminimum\b|\bbalance\b|\b(?:credit\s+)?limit\b|\bdue\b|\bupcoming\b|\bwill be charged\b|\btrial\b|请求|过期|失效|失败|被拒|拒绝|取消|撤销|冲正|预授权|冻结|待入账|账单|最低还款|余额|额度|到期|即将扣|试用/iu;
const REFUND_OK = /\bcancel(?:l?ed|lation)?\b|取消/iu;
const EXCLUDE_LABEL = /sub-?total|\btax\b|\bvat\b|shipping|delivery fee|\btip\b|balance|limit|available|points|小计|税|运费|配送费|小费|余额|额度|可用|积分/iu;
const INCLUDE_LABEL = /\btotal\b|amount (?:paid|charged|sent|received|refunded)|you (?:paid|sent|received)|order total|grand total|charged|合计|总计|实付|实收|支付金额|付款金额|交易金额|消费金额|退款金额|到账金额|收款金额|金额/iu;
/* i18n-ignore-end */

const SYMBOL: Record<string, string> = { "¥": "CNY", "￥": "CNY", "$": "USD", "€": "EUR", "£": "GBP" };
/** `$` in a mail from a .ca / .hk / .au / .sg / .nz sender is that country's dollar. */
const DOLLAR_BY_TLD: Record<string, string> = { ca: "CAD", hk: "HKD", au: "AUD", sg: "SGD", nz: "NZD" };
const NUMBER = "(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";

/** Every amount in a text with where it stands (`index`) and how its currency was written. */
export function amountMatches(text: string, fromAddress = ""): Array<{ value: number; currency: string; index: number; symbol: boolean }> {
  const out: Array<{ value: number; currency: string; index: number; symbol: boolean }> = [];
  const tld = fromAddress.toLowerCase().split(".").at(-1) ?? "";
  const num = (raw: string) => Number(raw.replace(/,/g, ""));
  for (const match of text.matchAll(new RegExp(`([¥￥$€£])\\s?${NUMBER}`, "g"))) {
    const symbol = match[1]!;
    out.push({ value: num(match[2]!), currency: symbol === "$" ? DOLLAR_BY_TLD[tld] ?? "USD" : SYMBOL[symbol]!, index: match.index ?? 0, symbol: true });
  }
  for (const match of text.matchAll(new RegExp(`\\b(CNY|RMB|USD|EUR|GBP|HKD|CAD|AUD|SGD|JPY|NZD)\\s?${NUMBER}`, "gi"))) {
    out.push({ value: num(match[2]!), currency: match[1]!.toUpperCase() === "RMB" ? "CNY" : match[1]!.toUpperCase(), index: match.index ?? 0, symbol: false });
  }
  for (const match of text.matchAll(new RegExp(`${NUMBER}\\s?(CNY|RMB|USD|EUR|GBP|HKD|CAD|AUD|SGD|JPY|NZD)\\b`, "gi"))) {
    out.push({ value: num(match[1]!), currency: match[2]!.toUpperCase() === "RMB" ? "CNY" : match[2]!.toUpperCase(), index: match.index ?? 0, symbol: false });
  }
  // i18n-ignore: currency words read in a mail's own text
  for (const match of text.matchAll(new RegExp(`${NUMBER}\\s?(元|人民币|美元|港币|港元)`, "g"))) {
    const word = match[2]!;
    out.push({ value: num(match[1]!), currency: word === "美元" ? "USD" : word.startsWith("港") ? "HKD" : "CNY", index: match.index ?? 0, symbol: false }); // i18n-ignore
  }
  return out.filter((item) => Number.isFinite(item.value) && item.value > 0);
}

/** The line around a position (bounded at 160 characters either side). */
function lineAt(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf("\n", index) + 1, index - 160);
  const endBreak = text.indexOf("\n", index);
  const end = Math.min(endBreak < 0 ? text.length : endBreak, index + 160);
  return text.slice(start, end);
}

/** Order, invoice and transaction numbers compared the same however they are written: `#00123-AB` and `123ab` are one. */
export const normalizeRef = (ref: string): string => ref.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+/, "");

/* i18n-ignore-start */
const PROCESSOR_PREFIX = /^(?:paypal\s*\*|sq\s*\*|tst\s*\*|sp\s*\*|apple\.com\/bill|google\s*\*|支付宝[-－—]|财付通[-－—]|微信支付[-－—])\s*/iu;
const NOISE = /\b(?:inc|llc|ltd|co|corp|com|www|store|#\d+|\d{3,})\b\.?|有限公司|公司|旗舰店|官方/giu;
/* i18n-ignore-end */
const MERCHANT_ALIASES: Array<[RegExp, string]> = [[/^amzn|^amazon/, "amazon"], [/^uber/, "uber"], [/^lyft/, "lyft"], [/^netflix/, "netflix"],
  [/^spotify/, "spotify"], [/^apple/, "apple"], [/^google/, "google"], [/^starbucks/, "starbucks"], [/^costco/, "costco"], [/^walmart/, "walmart"], [/^target\b/, "target"]];
/** Mail providers and platforms whose domain says nothing about the merchant. */
const GENERIC_DOMAINS = /^(?:gmail|outlook|hotmail|yahoo|qq|163|126|icloud|shopify|squareup|stripe|paypal|mail|email|e|info|notify|notifications|noreply)$/;

/** The registrable name of a sender address (`receipts@mail.costco.com` → `costco`), "" for a mail provider or a platform. */
export function senderKeyOf(fromAddress: string): string {
  const host = fromAddress.toLowerCase().split("@")[1] ?? "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const twoLevel = parts.length >= 3 && /^(?:com|co|net|org|gov|edu)$/.test(parts.at(-2)!) && parts.at(-1)!.length === 2;
  const name = parts.at(twoLevel ? -3 : -2) ?? "";
  return GENERIC_DOMAINS.test(name) ? "" : name;
}

/** One key for a merchant however a bank, a wallet or the merchant itself names it; falls back on the sender's domain. */
export function merchantKey(merchant: string, fromAddress = ""): string {
  const cleaned = merchant.toLowerCase().replace(PROCESSOR_PREFIX, "").replace(NOISE, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const compact = cleaned.replace(/\s+/g, "");
  for (const [pattern, key] of MERCHANT_ALIASES) if (pattern.test(compact)) return key;
  return compact.slice(0, 40) || senderKeyOf(fromAddress);
}

/** A few merchants whose category is plain (`其他` is never guessed). */
const MERCHANT_CATEGORY: Record<string, SpendCategory> = { uber: "交通", lyft: "交通", netflix: "订阅与软件", spotify: "订阅与软件", starbucks: "餐饮",
  costco: "买菜日用", walmart: "买菜日用", target: "购物", amazon: "购物" };
export const builtInCategory = (key: string): SpendCategory | "" => MERCHANT_CATEGORY[key] ?? "";

const addDays = (day: string, days: number) => new Date(Date.parse(`${day.slice(0, 10)}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * What a money mail is, from the model's reading checked against the mail's own text (`subject` and the first 8000 characters of `body`).
 * Only charges, receipts, refunds and income are booked, and only when the amount stands in the text beside a total's label (or alone in
 * the subject) and no veto word is in the subject or on the amount's line.
 */
export function moneyEventFromMail(reading: MoneyReading, mail: { subject: string; body: string; date: string; fromAddress: string }): MoneyVerdict {
  const event = reading.event;
  if (!event) return { book: false, reason: "not_money", event };
  const text = `${mail.subject}\n${mail.body.slice(0, 8000)}`;
  const lower = text.toLowerCase();
  const day = (mail.date || new Date().toISOString()).slice(0, 10);
  const refs = reading.refs.map((ref) => ref.trim()).filter((ref) => ref.length >= 4 && lower.includes(ref.toLowerCase())).slice(0, 4);
  const last4 = /^\d{4}$/.test(reading.last4) && text.includes(reading.last4) ? reading.last4 : "";
  const occurred = /^\d{4}-\d{2}-\d{2}$/.test(reading.occurredOn) && reading.occurredOn >= addDays(day, -10) && reading.occurredOn <= addDays(day, 1)
    && quoteSupportsDate(reading.occurredOn, text) ? reading.occurredOn : day;
  const key = merchantKey(reading.merchant, mail.fromAddress);
  const categories: readonly string[] = event === "income" ? INCOME_CATEGORIES : SPEND_CATEGORIES;
  const category = categories.includes(reading.category) ? reading.category : event === "income" ? "" : builtInCategory(key);
  const subjectAmounts = amountMatches(mail.subject, mail.fromAddress);
  const candidates = amountMatches(text, mail.fromAddress).filter((item) => Math.abs(item.value - reading.amount) < 0.005);
  const wanted = reading.currency.trim().toUpperCase().replace(/^RMB$/, "CNY");
  const located = candidates.find((item) => {
    if (wanted && item.currency !== wanted && !(item.symbol && wanted.endsWith("D") && item.currency.endsWith("D"))) return false;
    const line = lineAt(text, item.index);
    const before = text.slice(Math.max(0, item.index - 40), item.index);
    const label = reading.amountLabel.trim().toLowerCase();
    if (EXCLUDE_LABEL.test(before) && !INCLUDE_LABEL.test(before)) return false;
    if (INCLUDE_LABEL.test(line) || (label.length >= 2 && line.toLowerCase().includes(label))) return true;
    if (item.index < mail.subject.length && new Set(subjectAmounts.map((entry) => entry.value)).size === 1) return true;
    return new Set(amountMatches(text, mail.fromAddress).map((entry) => entry.value)).size === 1;
  });
  const evidence = located ? {
    kind: event === "income" ? "income" as const : event === "refund" ? "refund" as const : "expense" as const,
    value: reading.amount, currency: wanted || located.currency, at: occurred,
    merchant: reading.merchant.trim().slice(0, 60), merchantKey: key, category, refs, last4, instrument: reading.instrument, role: event, senderKey: senderKeyOf(mail.fromAddress)
  } : undefined;
  if (event === "failed") return { book: false, reason: "not_booked", event, ...(evidence ? { voids: evidence } : {}) };
  if (!BOOKABLE_EVENTS.includes(event)) return { book: false, reason: "not_booked", event };
  const veto = (value: string) => VETO.test(event === "refund" ? value.replace(new RegExp(REFUND_OK.source, "giu"), "") : value);
  if (veto(mail.subject) || (located && veto(lineAt(text, located.index)))) return { book: false, reason: "vetoed", event };
  if (!evidence) return { book: false, reason: "amount_unverified", event };
  return { book: true, evidence };
}

/** Whether a mail's subject alone keeps it out of the bookkeeping (a request, a hold, a statement, a failure …), as the repair reads old records. */
export const moneySubjectVetoed = (subject: string, refund = false): boolean =>
  VETO.test(refund ? subject.replace(new RegExp(REFUND_OK.source, "giu"), "") : subject);
/** A refund named in a mail's subject or a record's note. */
export const REFUND_WORDS = /\brefund(?:ed)?\b|退款|退货款/iu; // i18n-ignore

/** What a stored record offers the matcher: its own fields and the evidence already behind it. */
export type MatchTarget = { kind: string; value: number; currency: string; at: string; merchantKey: string; account: string;
  evidence: Array<{ sourceKey: string; role: string; senderKey: string; refs: string[] }> };

/** Scores above this attach the evidence to the record; between this and `POSSIBLE_SCORE` the two are kept and the person is asked. */
export const MERGE_SCORE = 70;
export const POSSIBLE_SCORE = 40;
/** How far apart in days two pieces may be and still be one transaction. */
export const MATCH_WINDOW_DAYS = 10;

/**
 * How likely a piece of evidence and a record are one transaction (docs/mail-bookkeeping.md §4.3). Hard rules block a merge whatever the
 * score: another currency or kind, different card digits, order numbers on both sides that differ, the same sender sending the same kind
 * of mail again (two coffees on one day), the window passed.
 */
export function matchScore(evidence: Pick<MoneyEvidence, "kind" | "value" | "currency" | "at" | "merchantKey" | "last4" | "refs" | "role" | "senderKey" | "sourceKey">,
  target: MatchTarget): { score: number; blocked?: string } {
  if (target.kind !== evidence.kind) return { score: 0, blocked: "kind" };
  if ((target.currency || "") !== (evidence.currency || "") && target.currency && evidence.currency) return { score: 0, blocked: "currency" };
  const gap = Math.abs(Date.parse(target.at.slice(0, 10)) - Date.parse(evidence.at.slice(0, 10))) / 86_400_000;
  if (gap > MATCH_WINDOW_DAYS) return { score: 0, blocked: "window" };
  const targetLast4 = target.account.match(/\d{4}$/)?.[0] ?? "";
  if (targetLast4 && evidence.last4 && targetLast4 !== evidence.last4) return { score: 0, blocked: "card" };
  if (target.evidence.some((item) => item.sourceKey !== evidence.sourceKey && item.role === evidence.role && item.senderKey && item.senderKey === evidence.senderKey)) {
    return { score: 0, blocked: "same_sender" };
  }
  const mine = new Set(evidence.refs.map(normalizeRef).filter(Boolean));
  const theirs = new Set(target.evidence.flatMap((item) => item.refs).map(normalizeRef).filter(Boolean));
  const sharedRef = [...mine].some((ref) => theirs.has(ref));
  if (mine.size && theirs.size && !sharedRef) return { score: 0, blocked: "refs" };
  // Without a shared order number, another amount is another payment (a hold that settles higher is never booked, so never compared).
  if (!sharedRef && Math.abs(target.value - evidence.value) >= 0.005) return { score: 0, blocked: "amount" };
  let score = sharedRef ? 70 : 0;
  if (evidence.merchantKey && target.merchantKey && (evidence.merchantKey === target.merchantKey
    || (Math.min(evidence.merchantKey.length, target.merchantKey.length) >= 4 && (evidence.merchantKey.includes(target.merchantKey) || target.merchantKey.includes(evidence.merchantKey))))) score += 20;
  if (Math.abs(target.value - evidence.value) < 0.005) score += 25;
  if (targetLast4 && evidence.last4) score += 15;
  score += gap <= 1 ? 15 : gap <= 3 ? 8 : gap <= 7 ? 3 : 0;
  if (!target.evidence.some((item) => item.role === evidence.role && item.senderKey === evidence.senderKey)) score += 10;
  return { score };
}
