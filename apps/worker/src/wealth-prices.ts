import { longbridgeToolAllowed } from "@crossline/connectors";
import {
  converterFrom, latestSnapshots, valueHoldings, BROKERAGE_SYMBOL, CRYPTO_IDS, QUOTE_READING_SCHEMA, type MarketPrice, type QuoteReading
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

/**
 * The public prices the ledger's assets are valued with (docs/ledger-wealth.md §2–3), once a day, cached for every workspace and read
 * offline from the cache:
 *
 * - **FX**: the ECB's daily reference rates through Frankfurter v1 (no key, no quota, ECB data only — not its blended v2). Working days
 *   only; a weekend reads Friday's rate, and the page names the rate's day. History is fetched once, back to the oldest record that needs it.
 * - **Crypto**: CoinGecko's public `simple/price`, one request for every coin the workspaces hold (the keyless tier allows a few calls a
 *   minute; one a day is far inside it). Only coins in `CRYPTO_IDS`; any other is priced by hand.
 * - **Brokerage quotes**: Longbridge, read through the person's own ChatGPT connector by `crossline-quote-reader`, `quote` only
 *   (`longbridgeToolAllowed`; any other tool call ends the run as it starts, `connectorAllowed`). A price is kept only when the same number stands in that call's result.
 *
 * What goes out: currency codes, coin ids and ticker symbols. Never an amount, an account or a name.
 */
export type FetchJson = (url: string) => Promise<unknown>;
export type QuoteReader = (symbols: string[], today: string) => Promise<Array<{ symbol: string; price: number; currency: string; day: string }>>;

const FRANKFURTER = "https://api.frankfurter.dev/v1";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const defaultFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Crossline (personal ledger)" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
};

/** ECB rates as Frankfurter returns them, one day (`{date, rates}`) or a range (`{rates: {day: {...}}}`), into cache rows (units per EUR). */
export function fxRows(body: unknown, fetchedAt: string): MarketPrice[] {
  const value = body as { date?: unknown; base?: unknown; rates?: Record<string, unknown> } | null;
  if (!value || (value.base !== undefined && value.base !== "EUR") || !value.rates || typeof value.rates !== "object") return [];
  const days: Array<[string, Record<string, unknown>]> = typeof value.date === "string" ? [[value.date, value.rates]]
    : Object.entries(value.rates).filter((entry): entry is [string, Record<string, unknown>] => DAY.test(entry[0]) && Boolean(entry[1]) && typeof entry[1] === "object");
  return days.filter(([day]) => DAY.test(day)).flatMap(([day, rates]) => Object.entries(rates)
    .filter((entry): entry is [string, number] => /^[A-Z]{3}$/.test(entry[0]) && typeof entry[1] === "number" && entry[1] > 0)
    .map(([symbol, price]) => ({ kind: "fx" as const, symbol, day, price, currency: "EUR", source: "ecb", fetchedAt })));
}

/** CoinGecko's `{bitcoin: {usd: 1}}` into cache rows by symbol, dated today (UTC: the price is "now"). */
export function cryptoRows(body: unknown, symbols: string[], day: string, fetchedAt: string): MarketPrice[] {
  const value = (body ?? {}) as Record<string, { usd?: unknown } | undefined>;
  return symbols.flatMap((symbol) => {
    const price = value[CRYPTO_IDS[symbol] ?? ""]?.usd;
    return typeof price === "number" && price > 0 ? [{ kind: "crypto" as const, symbol, day, price, currency: "USD", source: "coingecko", fetchedAt }] : [];
  });
}

const bareTool = (tool: string) => tool.replace(/^mcp__codex_apps__/, "").replace(/^longbridge_/, "");
/** The one connector call a quote reading may make: Longbridge's `quote`. Checked as each call starts and again on the result. */
export const isQuoteCall = (call: { server: string; tool: string }) =>
  /longbridge/i.test(`${call.server} ${call.tool}`) && longbridgeToolAllowed(call.tool) && bareTool(call.tool) === "quote";
/** A listing's currency from its market (Longbridge symbols end in the market): what a price is in, whatever the model wrote. */
const MARKET_CURRENCY: Record<string, string> = { US: "USD", HK: "HKD", SH: "CNY", SZ: "CNY", SG: "SGD" };
export const marketCurrency = (symbol: string) => MARKET_CURRENCY[symbol.trim().toUpperCase().split(".").at(-1) ?? ""] ?? "";
const numbersIn = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/**
 * The quotes to keep from one reading: the run must have called only Longbridge's `quote` (an account, order or other tool voids it, and ends the run as it starts), and
 * each price must stand as a number in a `quote` result that also names its symbol. Anything else is the model's word, so it is dropped.
 */
export function verifiedQuotes(reading: QuoteReading, calls: Array<Record<string, unknown>>, wanted: string[]): Array<{ symbol: string; price: number; currency: string; day: string }> {
  const named = calls.map((call) => ({ tool: String(call.tool ?? ""), server: String(call.server ?? ""), text: JSON.stringify(call.result ?? "") }));
  if (named.some((call) => !isQuoteCall(call))) return [];
  const results = named.map((call) => ({ upper: call.text.toUpperCase(), numbers: numbersIn(call.text) }));
  return reading.quotes.flatMap((quote) => {
    const symbol = quote.symbol.trim().toUpperCase();
    if (!wanted.includes(symbol) || !(quote.price > 0)) return [];
    const code = symbol.split(".")[0]!;
    const backed = results.some((result) => result.upper.includes(code) && result.numbers.some((number) => Math.abs(number - quote.price) <= Math.abs(quote.price) * 1e-9));
    // The currency is the market's (a 700.HK price is HKD in any account); a symbol without a known market keeps it only from the result.
    const said = quote.currency.trim().toUpperCase();
    const currency = marketCurrency(symbol) || (/^[A-Z]{3}$/.test(said) && results.some((result) => result.upper.includes(said)) ? said : "");
    return backed && currency ? [{ symbol, price: quote.price, currency, day: DAY.test(quote.tradeDay) ? quote.tradeDay : "" }] : [];
  });
}

export const QUOTE_READER = "crossline:crossline-quote-reader";
const QUOTE_INSTRUCTIONS = "Read the last price of each symbol with the Longbridge connector's quote tool only, copying each number exactly as the tool returned it. "
  + "Call no other tool. Leave out any symbol the tool did not price. Return raw JSON only.";

/** The quote reader on the person's own Codex (ChatGPT sign-in; connectors read-only). */
export function codexQuoteReader(client: CodexRpcBoundary, cwd: string): QuoteReader {
  return async (symbols, today) => {
    const calls: Array<Record<string, unknown>> = [];
    const input = { version: "crossline.quote-reading.v1", symbols, today };
    const result = await runCodexSkill(client, input, { skillName: QUOTE_READER, cwd, developerInstructions: QUOTE_INSTRUCTIONS, outputSchema: QUOTE_READING_SCHEMA,
      prepareInput: () => input, connectors: true, connectorAllowed: isQuoteCall, onConnectorCall: (item) => calls.push(item), onAudit: () => {}, timeoutMs: 10 * 60_000,
      validateOutput: (output) => output as QuoteReading });
    return result.ok ? verifiedQuotes(result.output, calls, symbols).map((quote) => ({ ...quote, day: quote.day || today })) : [];
  };
}

/** A failed fetch is not retried for an hour (per source), so an offline machine does not hammer anything. */
const failedAt = new Map<string, number>();
const coolingDown = (key: string, now: Date) => now.getTime() - (failedAt.get(key) ?? 0) < 3_600_000;
async function attempt<T>(key: string, now: Date, run: () => Promise<T>): Promise<T | undefined> {
  if (coolingDown(key, now)) return undefined;
  try { return await run(); } catch (error) { failedAt.set(key, now.getTime()); console.warn(JSON.stringify({ type: "wealth.price_failed", source: key, error: String(error) })); return undefined; }
}

/**
 * A quote reading is a model run, so one that fails (throws, or leaves a due symbol unpriced — a delisted one never will be) waits an hour,
 * then two, doubling up to a day; a reading that prices every due symbol clears it. Kept in the workspace's settings so a restarted worker
 * waits too.
 */
export const QUOTE_RETRY_SETTING = "wealth.quotes.retry";
const QUOTE_BACKOFF_MS = 3_600_000;
const QUOTE_BACKOFF_MAX_MS = 24 * 3_600_000;
function readQuoteRetry(store: CrosslineStore, workspaceId: string): { failures: number; retryAt: string } {
  try {
    const value = JSON.parse(store.getSetting(workspaceId, QUOTE_RETRY_SETTING) || "null") as { failures?: unknown; retryAt?: unknown } | null;
    return { failures: typeof value?.failures === "number" ? value.failures : 0, retryAt: typeof value?.retryAt === "string" ? value.retryAt : "" };
  } catch { return { failures: 0, retryAt: "" }; }
}
const quoteReadDue = (store: CrosslineStore, workspaceId: string, now: Date) => {
  const { retryAt } = readQuoteRetry(store, workspaceId);
  return !retryAt || !(Date.parse(retryAt) > now.getTime());
};
function noteQuoteRead(store: CrosslineStore, workspaceId: string, now: Date, complete: boolean): void {
  if (complete) { store.deleteSetting(workspaceId, QUOTE_RETRY_SETTING); return; }
  const failures = readQuoteRetry(store, workspaceId).failures + 1;
  const wait = Math.min(QUOTE_BACKOFF_MAX_MS, QUOTE_BACKOFF_MS * 2 ** Math.min(failures - 1, 10));
  store.setSetting(workspaceId, QUOTE_RETRY_SETTING, JSON.stringify({ failures, retryAt: new Date(now.getTime() + wait).toISOString() }));
}

/** The person's day, in the zone their schedule names (the web's `personToday`). */
function localDay(store: CrosslineStore, workspaceId: string, now: Date): string {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); } catch { return now.toISOString().slice(0, 10); }
}

export type WealthPriceDeps ={ now?: Date; fetchJson?: FetchJson; readQuotes?: QuoteReader | undefined };

/**
 * One workspace's daily pass: rates, coin prices and quotes that are missing for today (UTC), then each brokerage or crypto account with
 * every holding priced gets today's valuation as a snapshot — unless the person entered one for today, which stands.
 */
export async function wealthPricePass(store: CrosslineStore, workspaceId: string, deps: WealthPriceDeps = {}): Promise<{ fx: number; crypto: number; quotes: number; valued: number }> {
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const fetchedAt = now.toISOString();
  const counts = { fx: 0, crypto: 0, quotes: 0, valued: 0 };
  const accounts = store.listWealthAccounts(workspaceId).filter((account) => !account.archivedAt);
  const records = store.listRecords(workspaceId, { domain: "wealth" }).filter((record) => ["income", "expense", "refund"].includes(record.kind));
  if (!accounts.length && !records.length) return counts;

  // FX: today's rates once a day; the history back to the oldest day that needs a rate, once. A day converts only at a rate on or before
  // it (never a later one), so the history starts a week early: the oldest record may fall on a weekend or holiday with no rate of its own.
  const cached = store.listMarketPrices({ kinds: ["fx"] });
  const needed = [...records.map((record) => record.at.slice(0, 10)), ...store.listWealthSnapshots(workspaceId).map((snapshot) => snapshot.on)].sort()[0] ?? today;
  const earliest = cached[0]?.day;
  const from = [needed, addDays(today, -3 * 366)].sort().at(-1)!;
  if (!earliest || earliest > from) {
    const body = await attempt("fx-history", now, () => fetchJson(`${FRANKFURTER}/${addDays(from, -7)}..${today}`));
    if (body) counts.fx += store.saveMarketPrices(fxRows(body, fetchedAt));
  }
  if (!cached.some((row) => row.fetchedAt.slice(0, 10) === today)) {
    const body = await attempt("fx", now, () => fetchJson(`${FRANKFURTER}/latest`));
    if (body) counts.fx += store.saveMarketPrices(fxRows(body, fetchedAt));
  }

  const holdings = store.listWealthHoldings(workspaceId).filter((holding) => holding.quantity > 0);
  const classOf = new Map(accounts.map((account) => [account.id, account.accountClass]));
  const fresh = (kind: "quote" | "crypto") => new Set(store.listMarketPrices({ kinds: [kind] }).filter((row) => row.fetchedAt.slice(0, 10) === today).map((row) => row.symbol));

  const coins = [...new Set(holdings.filter((holding) => classOf.get(holding.accountId) === "crypto" && CRYPTO_IDS[holding.symbol]).map((holding) => holding.symbol))];
  const coinsDone = fresh("crypto");
  const coinsDue = coins.filter((symbol) => !coinsDone.has(symbol));
  if (coinsDue.length) {
    const ids = coinsDue.map((symbol) => CRYPTO_IDS[symbol]).join(",");
    const body = await attempt("crypto", now, () => fetchJson(`${COINGECKO}?ids=${encodeURIComponent(ids)}&vs_currencies=usd`));
    if (body) counts.crypto += store.saveMarketPrices(cryptoRows(body, coinsDue, today, fetchedAt));
  }

  const symbols = [...new Set(holdings.filter((holding) => classOf.get(holding.accountId) === "brokerage" && BROKERAGE_SYMBOL.test(holding.symbol)).map((holding) => holding.symbol))];
  const quotesDone = fresh("quote");
  const quotesDue = symbols.filter((symbol) => !quotesDone.has(symbol));
  if (quotesDue.length && deps.readQuotes && quoteReadDue(store, workspaceId, now)) {
    let quotes: Awaited<ReturnType<QuoteReader>> = [];
    try { quotes = await deps.readQuotes(quotesDue, today); } catch (error) { console.warn(JSON.stringify({ type: "wealth.price_failed", source: `quotes:${workspaceId}`, error: String(error) })); }
    if (quotes.length) counts.quotes += store.saveMarketPrices(quotes.map((quote) => ({ kind: "quote" as const, symbol: quote.symbol, day: quote.day, price: quote.price,
      currency: quote.currency, source: "longbridge", fetchedAt })));
    noteQuoteRead(store, workspaceId, now, quotesDue.every((symbol) => quotes.some((quote) => quote.symbol === symbol)));
  }

  // Valuations: what the holdings are worth on the person's own day, as the account's snapshot for that day.
  const local = localDay(store, workspaceId, now);
  const fx = converterFrom(store.listMarketPrices({ kinds: ["fx"] }));
  const prices = store.listMarketPrices({ kinds: ["quote", "crypto"] });
  const snapshots = store.listWealthSnapshots(workspaceId);
  const typedToday = new Set(snapshots.filter((snapshot) => snapshot.on === local && snapshot.source !== "valuation").map((snapshot) => snapshot.accountId));
  const lastOf = latestSnapshots(snapshots, local);
  for (const account of accounts) {
    if ((account.accountClass !== "brokerage" && account.accountClass !== "crypto") || typedToday.has(account.id)) continue;
    // Everything sold or removed: an account the holdings valued is worth 0 from today, not its last valuation forever. One the person keeps
    // by typed balances (no holdings ever) is left alone.
    const holdsNothing = !holdings.some((holding) => holding.accountId === account.id && holding.quantity > 0);
    const last = lastOf.get(account.id);
    const valued = holdsNothing ? (last?.source === "valuation" && last.value !== 0 ? { value: 0 } : null) : valueHoldings(account, holdings, prices, fx, local);
    if (!valued) continue;
    store.saveWealthSnapshot(workspaceId, { id: `val-${account.id}-${local}`, accountId: account.id, on: local, value: valued.value, source: "valuation", createdAt: fetchedAt });
    counts.valued += 1;
  }
  return counts;
}
