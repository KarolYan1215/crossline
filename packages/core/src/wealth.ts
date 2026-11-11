/**
 * Assets and liabilities beside the ledger (docs/ledger-wealth.md, the owner's decisions of 2026-11-10): accounts the person names, dated
 * balance snapshots they enter, brokerage and crypto holdings valued from a quote, a base currency every total is converted into with a
 * daily rate, and budgets. Everything here is pure: the store keeps the rows, the worker fetches prices, the page draws what this computes.
 *
 * What it deliberately is not: no bank is connected, so a balance is only as fresh as the person's last snapshot (or the last quote of a
 * holding); no number here is a model's; nothing advises buying or selling.
 */

export const ASSET_CLASSES = ["cash", "brokerage", "retirement", "crypto", "property"] as const;
export const LIABILITY_CLASSES = ["credit_card", "student_loan", "other_loan"] as const;
export const ACCOUNT_CLASSES = [...ASSET_CLASSES, ...LIABILITY_CLASSES] as const;
export type AssetClass = typeof ASSET_CLASSES[number];
export type LiabilityClass = typeof LIABILITY_CLASSES[number];
export type AccountClass = typeof ACCOUNT_CLASSES[number];
/** Kept in Chinese (they are keys); translated where shown. */
export const ACCOUNT_CLASS_LABEL: Record<AccountClass, string> = {
  cash: "现金/储蓄", brokerage: "券商", retirement: "退休账户", crypto: "加密资产", property: "房产/其他",
  credit_card: "信用卡", student_loan: "学生贷款", other_loan: "其他贷款"
};
export const isAccountClass = (value: unknown): value is AccountClass => typeof value === "string" && (ACCOUNT_CLASSES as readonly string[]).includes(value);
export const isLiability = (accountClass: AccountClass) => (LIABILITY_CLASSES as readonly string[]).includes(accountClass);
/** Classes whose value comes from holdings × a price rather than a typed balance. */
export const HOLDING_CLASSES: readonly AccountClass[] = ["brokerage", "crypto"];

/**
 * Currencies with a daily reference rate (the ECB's list, which the worker reads through Frankfurter). A currency outside it is kept and
 * shown in its own unit, never converted with a guessed rate.
 */
export const FX_CURRENCIES = ["AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW",
  "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"] as const;
export const isFxCurrency = (code: string) => (FX_CURRENCIES as readonly string[]).includes(code);

/** Crypto symbols the worker can price from CoinGecko's public `simple/price`, by the coin's id there; any other symbol is priced by hand. */
export const CRYPTO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", USDT: "tether", USDC: "usd-coin", BNB: "binancecoin", XRP: "ripple", DOGE: "dogecoin",
  ADA: "cardano", TRX: "tron", TON: "the-open-network", AVAX: "avalanche-2", DOT: "polkadot", LTC: "litecoin", LINK: "chainlink"
};
/** A brokerage symbol as Longbridge writes it: code and market (AAPL.US, 700.HK, 600519.SH). */
export const BROKERAGE_SYMBOL = /^[A-Z0-9][A-Z0-9-]{0,11}\.(US|HK|SH|SZ|SG)$/;
const CRYPTO_SYMBOL = /^[A-Z0-9]{2,10}$/;

export type WealthAccount = { id: string; name: string; accountClass: AccountClass; currency: string; note: string; archivedAt: string; createdAt: string };
/** A balance on a day. A liability's is what is owed, positive. `source`: the person typed it, the 小帮手's card wrote it, or the worker valued holdings. */
export type WealthSnapshot = { id: string; accountId: string; on: string; value: number; source: "person" | "assistant" | "valuation"; createdAt: string };
/** A position: `price` is the person's own (0 = none), used when no quote is known. */
export type WealthHolding = { id: string; accountId: string; symbol: string; quantity: number; price: number; priceCurrency: string; priceOn: string; updatedAt: string };
/** A cached public price: an FX rate (units of `symbol` per one EUR), a brokerage quote or a crypto price, on the day its source dated it. */
export type MarketPrice = { kind: "fx" | "quote" | "crypto"; symbol: string; day: string; price: number; currency: string; source: string; fetchedAt: string };

const round2 = (value: number) => Math.round(value * 100) / 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The base currency the totals are shown in, until the person picks one: from the time zone they live in, else the interface language.
 * Only currencies with a reference rate are offered.
 */
export function baseCurrencyFor(timeZone: string, locale: string): string {
  const zone = timeZone.trim();
  const byZone: Array<[RegExp, string]> = [
    [/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Kashgar)$|^PRC$/, "CNY"], [/^Asia\/(Hong_Kong|Macau)$/, "HKD"], [/^Asia\/Tokyo$/, "JPY"],
    [/^Asia\/Seoul$/, "KRW"], [/^Asia\/Singapore$/, "SGD"], [/^Asia\/(Kolkata|Calcutta)$/, "INR"], [/^Asia\/Bangkok$/, "THB"],
    [/^Asia\/Kuala_Lumpur$/, "MYR"], [/^Asia\/Jakarta$/, "IDR"], [/^Asia\/Manila$/, "PHP"], [/^Asia\/(Jerusalem|Tel_Aviv)$/, "ILS"],
    [/^Australia\//, "AUD"], [/^Pacific\/Auckland$/, "NZD"],
    [/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal)$|^Canada\//, "CAD"], [/^America\/(Mexico_City|Cancun|Monterrey|Tijuana)$/, "MXN"],
    [/^America\/Sao_Paulo$/, "BRL"], [/^America\/|^US\//, "USD"], [/^Pacific\/Honolulu$/, "USD"],
    [/^Europe\/(London|Belfast)$|^GB$/, "GBP"], [/^Europe\/Zurich$/, "CHF"], [/^Europe\/Stockholm$/, "SEK"], [/^Europe\/Oslo$/, "NOK"],
    [/^Europe\/Copenhagen$/, "DKK"], [/^Europe\/Warsaw$/, "PLN"], [/^Europe\/Prague$/, "CZK"], [/^Europe\/Budapest$/, "HUF"], [/^Europe\/Bucharest$/, "RON"],
    [/^Europe\/Sofia$/, "BGN"], [/^Europe\/Istanbul$/, "TRY"], [/^Atlantic\/Reykjavik$/, "ISK"], [/^Africa\/Johannesburg$/, "ZAR"],
    [/^Europe\/(Berlin|Paris|Madrid|Rome|Amsterdam|Brussels|Vienna|Dublin|Lisbon|Helsinki|Athens|Luxembourg|Bratislava|Ljubljana|Tallinn|Riga|Vilnius|Zagreb|Valletta|Monaco)$/, "EUR"],
    [/^Asia\/Taipei$/, "USD"]
  ];
  for (const [pattern, currency] of byZone) if (pattern.test(zone)) return currency;
  return /^zh/i.test(locale) ? "CNY" : "USD";
}

/** One currency into another with the rates cached by day. */
export type Converter = {
  /** `value` in `from` as `to` on `day`: the latest rate on or before it, never a later day's; null when none covers both currencies by then. */
  convert(value: number, from: string, to: string, day: string): { value: number; rateDay: string } | null;
  /** The latest day any rate is cached for ("" with none). */
  latestDay: string;
};

/** Rates kept as units per one EUR (the ECB's base), so any pair is one division. */
export function converterFrom(prices: MarketPrice[]): Converter {
  const byDay = new Map<string, Map<string, number>>();
  for (const row of prices) if (row.kind === "fx" && row.price > 0 && DAY.test(row.day)) {
    const day = byDay.get(row.day) ?? new Map<string, number>([["EUR", 1]]);
    day.set(row.symbol.toUpperCase(), row.price);
    byDay.set(row.day, day);
  }
  const days = [...byDay.keys()].sort();
  const covers = (day: string, a: string, b: string) => { const rates = byDay.get(day)!; return rates.has(a) && rates.has(b); };
  return {
    latestDay: days.at(-1) ?? "",
    convert(value, from, to, day) {
      const a = (from || "CNY").toUpperCase(), b = (to || "CNY").toUpperCase();
      if (a === b) return { value, rateDay: "" };
      let chosen = "";
      for (const candidate of days) { if (candidate > day.slice(0, 10)) break; if (covers(candidate, a, b)) chosen = candidate; }
      if (!chosen) return null;
      const rates = byDay.get(chosen)!;
      return { value: value / rates.get(a)! * rates.get(b)!, rateDay: chosen };
    }
  };
}

/**
 * How old a cached quote or coin price may be on the day it values a holding (docs/ledger-wealth.md §2.3). Ten days rides out the longest
 * regular market closure (Golden Week, Spring Festival: about nine days); past it the symbol is taken as no longer quoted (delisted, renamed).
 */
export const QUOTE_MAX_AGE_DAYS = 10;

/**
 * The price a holding is valued at on `day`: the latest cached quote (brokerage) or crypto price on or before it, else the person's own.
 * `stale`: the quote is older than `QUOTE_MAX_AGE_DAYS` — shown with its day, never used for a value. The person's own price does not age.
 */
export function holdingPrice(holding: WealthHolding, accountClass: AccountClass, prices: MarketPrice[], day: string): { price: number; currency: string; on: string; source: string; stale: boolean } | null {
  const kind = accountClass === "crypto" ? "crypto" : "quote";
  const quote = prices.filter((row) => row.kind === kind && row.symbol === holding.symbol && row.day <= day && row.price > 0).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
  // The person's own price wins when it is newer than the last quote (a delisted stock, a coin no source knows).
  if (holding.price > 0 && (!quote || holding.priceOn > quote.day)) return { price: holding.price, currency: holding.priceCurrency, on: holding.priceOn, source: "person", stale: false };
  return quote ? { price: quote.price, currency: quote.currency, on: quote.day, source: quote.source, stale: dayDiff(day, quote.day) > QUOTE_MAX_AGE_DAYS } : null;
}

/**
 * An account's holdings valued on `day`, in the account's currency. Null when any holding has no price, only a stale one, or its price's
 * currency cannot be converted: a total with a hole in it would be wrong without saying so.
 */
export function valueHoldings(account: WealthAccount, holdings: WealthHolding[], prices: MarketPrice[], fx: Converter, day: string): { value: number; priceDay: string } | null {
  const own = holdings.filter((holding) => holding.accountId === account.id && holding.quantity > 0);
  if (!own.length) return null;
  let total = 0, priceDay = "";
  for (const holding of own) {
    const price = holdingPrice(holding, account.accountClass, prices, day);
    if (!price || price.stale) return null;
    const value = fx.convert(holding.quantity * price.price, price.currency || account.currency, account.currency, price.on || day);
    if (!value) return null;
    total += value.value;
    if (!priceDay || price.on < priceDay) priceDay = price.on;
  }
  return { value: round2(total), priceDay };
}

/** The latest snapshot of each account on or before `day`. */
export function latestSnapshots(snapshots: WealthSnapshot[], day: string): Map<string, WealthSnapshot> {
  const latest = new Map<string, WealthSnapshot>();
  for (const snapshot of [...snapshots].sort((a, b) => a.on.localeCompare(b.on) || a.createdAt.localeCompare(b.createdAt)))
    if (snapshot.on <= day) latest.set(snapshot.accountId, snapshot);
  return latest;
}

export type AccountValue = {
  account: WealthAccount; liability: boolean;
  /** In the account's own currency; null with no snapshot yet. */
  native: number | null; asOf: string;
  /** In the base currency; null when it has no snapshot or its currency has no rate. */
  base: number | null;
  /** Days since the snapshot on `day`; null with none. */
  ageDays: number | null;
};

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

/** Every live account's value on `day` (archived ones are left out after the day they were archived). */
export function accountValues(accounts: WealthAccount[], snapshots: WealthSnapshot[], fx: Converter, base: string, day: string): AccountValue[] {
  const latest = latestSnapshots(snapshots, day);
  return accounts.filter((account) => !account.archivedAt || account.archivedAt.slice(0, 10) > day).map((account) => {
    const snapshot = latest.get(account.id);
    const converted = snapshot ? fx.convert(snapshot.value, account.currency, base, day) : null;
    return { account, liability: isLiability(account.accountClass), native: snapshot ? snapshot.value : null, asOf: snapshot?.on ?? "",
      base: converted ? round2(converted.value) : null, ageDays: snapshot ? dayDiff(day, snapshot.on) : null };
  });
}

export type NetWorthPoint = { day: string; assets: number; liabilities: number; net: number; byClass: Partial<Record<AccountClass, number>>;
  /** Accounts that had a value but could not be converted on that day (left out of the sums). */
  unconverted: number };

/** Assets, liabilities and their difference on one day, in the base currency. */
export function netWorthOn(accounts: WealthAccount[], snapshots: WealthSnapshot[], fx: Converter, base: string, day: string): NetWorthPoint {
  let assets = 0, liabilities = 0, unconverted = 0;
  const byClass: Partial<Record<AccountClass, number>> = {};
  for (const item of accountValues(accounts, snapshots, fx, base, day)) {
    if (item.native === null) continue;
    if (item.base === null) { unconverted += 1; continue; }
    if (item.liability) liabilities += item.base; else assets += item.base;
    byClass[item.account.accountClass] = round2((byClass[item.account.accountClass] ?? 0) + item.base);
  }
  return { day, assets: round2(assets), liabilities: round2(liabilities), net: round2(assets - liabilities), byClass, unconverted };
}

const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const shiftMonth = (month: string, by: number) => { const at = new Date(`${month}-15T12:00:00Z`); at.setUTCMonth(at.getUTCMonth() + by); return at.toISOString().slice(0, 7); };

/**
 * The net-worth curve: one point at the end of each month from the first snapshot's month (at most `months` back), the last one today.
 * Between snapshots an account keeps its last value, which is what the person last knew; the page marks how old each one is.
 */
export function netWorthSeries(accounts: WealthAccount[], snapshots: WealthSnapshot[], fx: Converter, base: string, today: string, months = 24): NetWorthPoint[] {
  const first = snapshots.map((snapshot) => snapshot.on).sort()[0];
  if (!first) return [];
  const start = [first.slice(0, 7), shiftMonth(today.slice(0, 7), -(months - 1))].sort().at(-1)!;
  const points: NetWorthPoint[] = [];
  for (let month = start; month <= today.slice(0, 7); month = shiftMonth(month, 1)) {
    const day = month === today.slice(0, 7) ? today : monthEnd(month);
    points.push(netWorthOn(accounts, snapshots, fx, base, day));
  }
  return points;
}

/**
 * Accounts the 「更新余额」 card lists in `month`: live, typed by hand (holdings valued by a quote keep themselves fresh), and with no
 * snapshot since the month began.
 */
export function staleAccounts(accounts: WealthAccount[], snapshots: WealthSnapshot[], holdings: WealthHolding[], month: string): WealthAccount[] {
  const start = `${month}-01`;
  const valued = new Set(holdings.filter((holding) => holding.quantity > 0).map((holding) => holding.accountId));
  return accounts.filter((account) => !account.archivedAt && !(HOLDING_CLASSES.includes(account.accountClass) && valued.has(account.id))
    && !snapshots.some((snapshot) => snapshot.accountId === account.id && snapshot.on >= start));
}

/** The person's budget: a monthly cap and caps per spending category, in the base currency (0 or absent = none). No envelopes. */
export type Budget = { monthly: number | null; categories: Record<string, number> };
export type BudgetLine = { category: string; cap: number; spent: number; pct: number; projected: number | null; over: boolean; projectedOver: boolean };

/** Each capped category against this month's spending, with the month-end projection at the pace so far (from the third day). */
export function budgetLines(budget: Budget, categories: Array<{ category: string; amount: number }>, day: number, daysInMonth: number, current: boolean): BudgetLine[] {
  return Object.entries(budget.categories).filter(([, cap]) => cap > 0).map(([category, cap]) => {
    const spent = round2(categories.find((item) => item.category === category)?.amount ?? 0);
    const projected = current && day >= 3 ? round2(spent / day * daysInMonth) : null;
    return { category, cap, spent, pct: Math.round(spent / cap * 100), projected, over: spent > cap, projectedOver: projected !== null && projected > cap };
  }).sort((a, b) => b.pct - a.pct);
}

/** A budget read from its setting; anything malformed reads as no budget. */
export function parseBudget(raw: string | undefined): Budget {
  try {
    const value = JSON.parse(raw ?? "null") as { monthly?: unknown; categories?: unknown } | null;
    const monthly = typeof value?.monthly === "number" && value.monthly > 0 ? value.monthly : null;
    const categories = Object.fromEntries(Object.entries(value?.categories && typeof value.categories === "object" ? value.categories as Record<string, unknown> : {})
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0));
    return { monthly, categories };
  } catch { return { monthly: null, categories: {} }; }
}

/**
 * What the quote reader returns (`crossline-quote-reader`): the last price of each brokerage symbol as Longbridge's `quote` tool gave it.
 * The worker keeps a quote only when the same number stands in that tool call's own result (apps/worker/src/wealth-prices.ts).
 */
export const QUOTE_READING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["quotes"],
  properties: { quotes: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["symbol", "price", "currency", "tradeDay"],
    properties: { symbol: { type: "string", minLength: 1, maxLength: 20 }, price: { type: "number" }, currency: { type: "string", minLength: 0, maxLength: 3 },
      tradeDay: { type: "string", minLength: 0, maxLength: 10 } } } } }
} as const;
export type QuoteReading = { quotes: Array<{ symbol: string; price: number; currency: string; tradeDay: string }> };

/**
 * Money records restated in the base currency, each at its own day's rate, so the ledger sums one currency; a record whose currency has
 * no rate keeps its own and is listed beside the totals. `rateDay`: the latest rate day used ("" when nothing needed converting).
 */
export function convertRecords<T extends { value: number; currency: string; at: string }>(records: T[], base: string, fx: Converter): { records: T[]; rateDay: string } {
  let rateDay = "";
  const converted = records.map((record) => {
    const from = record.currency || "CNY";
    if (from === base) return record;
    const result = fx.convert(record.value, from, base, record.at.slice(0, 10));
    if (!result) return record;
    if (result.rateDay > rateDay) rateDay = result.rateDay;
    return { ...record, value: round2(result.value), currency: base };
  });
  return { records: converted, rateDay };
}

/* i18n-ignore-start: why a wealth entry cannot be kept, sent back to the model or shown as the refusal */
/** Why an account, a balance or a holding cannot be kept, in words a model can repair against; "" when it can. */
export function wealthProblem(input: { accountClass?: string; currency?: string; balance?: number; symbol?: string; quantity?: number; price?: number; at?: string }): string {
  if (input.accountClass !== undefined && input.accountClass !== "" && !isAccountClass(input.accountClass)) return `类别须是 ${ACCOUNT_CLASSES.join("/")}`;
  if (input.currency !== undefined && input.currency !== "" && !/^[A-Z]{3}$/.test(input.currency)) return "币种须是三个大写字母的代码，例如 CNY、USD";
  if (input.at !== undefined && input.at !== "" && !DAY.test(input.at)) return "日期须为 YYYY-MM-DD";
  if (input.symbol) {
    if (!Number.isFinite(input.quantity) || (input.quantity ?? 0) < 0 || (input.quantity ?? 0) > 1e12) return "数量须是不小于 0 的数";
    if (input.accountClass === "brokerage" && !BROKERAGE_SYMBOL.test(input.symbol)) return "券商代码须带市场后缀，例如 AAPL.US、700.HK、600519.SH";
    if (input.accountClass === "crypto" && !CRYPTO_SYMBOL.test(input.symbol)) return "加密资产代码须是大写字母，例如 BTC、ETH";
    if (input.accountClass && !HOLDING_CLASSES.includes(input.accountClass as AccountClass)) return "只有券商和加密资产账户记持仓；其他账户记余额";
    if (input.price !== undefined && (!Number.isFinite(input.price) || input.price < 0)) return "价格须是不小于 0 的数";
    return "";
  }
  if (input.balance !== undefined && (!Number.isFinite(input.balance) || input.balance < 0 || input.balance > 1e13)) return "余额须是不小于 0 的数（负债填欠款金额，也是正数）";
  return "";
}
/* i18n-ignore-end */
