import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { cryptoRows, fxRows, isQuoteCall, verifiedQuotes, wealthPricePass } from "./wealth-prices";

const quoteCall = (result: unknown, tool = "longbridge_quote") => ({ type: "mcpToolCall", server: "codex_apps", tool, status: "completed", result });

test("Frankfurter's one day and its range become per-EUR rows; another base is refused", () => {
  expect(fxRows({ amount: 1, base: "EUR", date: "2026-11-06", rates: { USD: 1.08, CNY: 7.7, bad: 1 } }, "t")).toEqual([
    { kind: "fx", symbol: "USD", day: "2026-11-06", price: 1.08, currency: "EUR", source: "ecb", fetchedAt: "t" },
    { kind: "fx", symbol: "CNY", day: "2026-11-06", price: 7.7, currency: "EUR", source: "ecb", fetchedAt: "t" }]);
  expect(fxRows({ base: "EUR", start_date: "2026-11-05", rates: { "2026-11-05": { USD: 1.07 }, "2026-11-06": { USD: 1.08 } } }, "t").map((row) => row.day)).toEqual(["2026-11-05", "2026-11-06"]);
  expect(fxRows({ base: "USD", date: "2026-11-06", rates: { CNY: 7.1 } }, "t")).toEqual([]);
  expect(cryptoRows({ bitcoin: { usd: 90000 }, ethereum: {} }, ["BTC", "ETH"], "2026-11-10", "t").map((row) => [row.symbol, row.price])).toEqual([["BTC", 90000]]);
});

test("a quote is kept only when the quote tool's own result holds that number for that symbol", () => {
  const reading = { quotes: [{ symbol: "AAPL.US", price: 231.45, currency: "USD", tradeDay: "2026-11-07" }, { symbol: "700.HK", price: 512, currency: "HKD", tradeDay: "" },
    { symbol: "TSLA.US", price: 300, currency: "USD", tradeDay: "" }] };
  const calls = [quoteCall({ content: [{ type: "text", text: JSON.stringify([{ symbol: "AAPL.US", last_done: "231.45" }, { symbol: "700.HK", last_done: "511.5" }]) }] })];
  // 700.HK's number is not the tool's; TSLA.US was never asked for.
  expect(verifiedQuotes(reading, calls, ["AAPL.US", "700.HK"])).toEqual([{ symbol: "AAPL.US", price: 231.45, currency: "USD", day: "2026-11-07" }]);
});

test("a price is in its market's currency, whatever the model wrote or left empty", () => {
  const calls = [quoteCall({ text: JSON.stringify([{ symbol: "700.HK", last_done: "512" }, { symbol: "600519.SH", last_done: "1500" }]) })];
  const reading = { quotes: [{ symbol: "700.HK", price: 512, currency: "", tradeDay: "" }, { symbol: "600519.SH", price: 1500, currency: "USD", tradeDay: "" }] };
  expect(verifiedQuotes(reading, calls, ["700.HK", "600519.SH"]).map((quote) => [quote.symbol, quote.currency])).toEqual([["700.HK", "HKD"], ["600519.SH", "CNY"]]);
  // No known market and no currency in the result: dropped rather than valued in the account's currency.
  expect(verifiedQuotes({ quotes: [{ symbol: "XYZ", price: 9.5, currency: "", tradeDay: "" }] }, [quoteCall({ text: "XYZ 9.5" })], ["XYZ"])).toEqual([]);
});

test("only Longbridge's quote may start in a quote reading: an account tool is refused before its result is read", () => {
  expect(isQuoteCall({ server: "codex_apps", tool: "longbridge_quote" })).toBe(true);
  expect(isQuoteCall({ server: "codex_apps", tool: "longbridge_account_balance" })).toBe(false);
  expect(isQuoteCall({ server: "codex_apps", tool: "longbridge_submit_order" })).toBe(false);
  expect(isQuoteCall({ server: "gmail", tool: "search" })).toBe(false);
});

test("any call beside Longbridge's quote voids the whole reading", () => {
  const reading = { quotes: [{ symbol: "AAPL.US", price: 231.45, currency: "USD", tradeDay: "" }] };
  const good = quoteCall({ text: "AAPL.US 231.45" });
  expect(verifiedQuotes(reading, [good, quoteCall({ text: "cash 1000" }, "longbridge_account_balance")], ["AAPL.US"])).toEqual([]);
  expect(verifiedQuotes(reading, [good, quoteCall({ text: "AAPL.US 231.45" }, "longbridge_candlesticks")], ["AAPL.US"])).toEqual([]);
  expect(verifiedQuotes(reading, [good, { type: "mcpToolCall", server: "gmail", tool: "search", result: "AAPL 231.45" }], ["AAPL.US"])).toEqual([]);
  expect(verifiedQuotes(reading, [], ["AAPL.US"])).toEqual([]);
});

test("the daily pass fetches once, values held positions, and leaves the person's own balance of the day alone", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "schedule.preferences", JSON.stringify({ timeZone: "Asia/Shanghai" }));
  const now = new Date("2026-11-10T04:00:00Z");
  store.saveWealthAccount("w", { id: "b", name: "长桥", accountClass: "brokerage", currency: "USD", note: "", archivedAt: "", createdAt: "x" });
  store.saveWealthAccount("w", { id: "c", name: "钱包", accountClass: "crypto", currency: "CNY", note: "", archivedAt: "", createdAt: "x" });
  store.saveWealthHolding("w", { id: "h1", accountId: "b", symbol: "AAPL.US", quantity: 10, price: 0, priceCurrency: "", priceOn: "", updatedAt: "x" });
  store.saveWealthHolding("w", { id: "h2", accountId: "c", symbol: "BTC", quantity: 0.5, price: 0, priceCurrency: "", priceOn: "", updatedAt: "x" });
  store.saveWealthSnapshot("w", { id: "s", accountId: "c", on: "2026-11-01", value: 1, source: "person", createdAt: "x" });
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    if (url.includes("coingecko")) return { bitcoin: { usd: 80000 } };
    if (url.endsWith("/latest")) return { base: "EUR", date: "2026-11-09", rates: { USD: 1.1, CNY: 7.7 } };
    return { base: "EUR", rates: { "2026-11-01": { USD: 1.1, CNY: 7.7 } } };
  };
  const asked: string[][] = [];
  const readQuotes = async (symbols: string[]) => { asked.push(symbols); return [{ symbol: "AAPL.US", price: 200, currency: "USD", day: "2026-11-07" }]; };
  const first = await wealthPricePass(store, "w", { now, fetchJson, readQuotes });
  expect(first).toMatchObject({ crypto: 1, quotes: 1, valued: 2 });
  // A week before the oldest balance, so its day has a rate on or before it.
  expect(urls.some((url) => url.includes("2026-10-25..2026-11-10"))).toBe(true);
  // The local day in Shanghai: the valuation is dated there, not in UTC.
  const snaps = store.listWealthSnapshots("w").filter((item) => item.source === "valuation");
  expect(snaps.map((item) => [item.accountId, item.on, item.value])).toEqual([["b", "2026-11-10", 2000], ["c", "2026-11-10", 280000]]);
  // Again the same day: nothing fetched or asked twice.
  urls.length = 0;
  await wealthPricePass(store, "w", { now, fetchJson, readQuotes });
  expect(urls).toEqual([]);
  expect(asked).toHaveLength(1);
  // The person's own balance for today wins over the valuation.
  store.saveWealthSnapshot("w", { id: "p", accountId: "b", on: "2026-11-10", value: 2500, source: "person", createdAt: "y" });
  await wealthPricePass(store, "w", { now, fetchJson, readQuotes });
  expect(store.listWealthSnapshots("w").find((item) => item.accountId === "b" && item.on === "2026-11-10")).toMatchObject({ value: 2500, source: "person" });
  // The coin sold (quantity 0): the next day the wallet is worth 0, not its last valuation for ever after.
  store.saveWealthHolding("w", { id: "h2", accountId: "c", symbol: "BTC", quantity: 0, price: 0, priceCurrency: "", priceOn: "", updatedAt: "z" });
  await wealthPricePass(store, "w", { now: new Date("2026-11-11T04:00:00Z"), fetchJson, readQuotes });
  expect(store.listWealthSnapshots("w").find((item) => item.accountId === "c" && item.on === "2026-11-11")).toMatchObject({ value: 0, source: "valuation" });
  store.close();
});

test("a quote reading that fails or leaves a symbol unpriced waits an hour, doubling to a day, and is reset by a full reading", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveWealthAccount("w", { id: "b", name: "长桥", accountClass: "brokerage", currency: "USD", note: "", archivedAt: "", createdAt: "x" });
  store.saveWealthHolding("w", { id: "h1", accountId: "b", symbol: "AAPL.US", quantity: 10, price: 0, priceCurrency: "", priceOn: "", updatedAt: "x" });
  const fetchJson = async (url: string) => url.endsWith("/latest") ? { base: "EUR", date: "2026-11-09", rates: { USD: 1.1 } } : { base: "EUR", rates: { "2026-11-02": { USD: 1.1 } } };
  let answer: "throw" | "empty" | "ok" = "throw";
  let asked = 0;
  const readQuotes = async () => {
    asked += 1;
    if (answer === "throw") throw new Error("CODEX_DOWN");
    return answer === "ok" ? [{ symbol: "AAPL.US", price: 200, currency: "USD", day: "2026-11-09" }] : [];
  };
  const at = (iso: string) => wealthPricePass(store, "w", { now: new Date(iso), fetchJson, readQuotes });
  await at("2026-11-10T00:00:00Z");
  expect(asked).toBe(1);
  // Every tick inside the hour asks nothing, a restarted worker included (the wait is in the ledger, not in memory).
  await at("2026-11-10T00:10:00Z");
  await at("2026-11-10T00:59:00Z");
  expect(asked).toBe(1);
  answer = "empty";
  await at("2026-11-10T01:00:00Z");
  expect(asked).toBe(2);
  // The second failure doubles the wait to two hours.
  await at("2026-11-10T02:30:00Z");
  expect(asked).toBe(2);
  answer = "ok";
  await at("2026-11-10T03:00:00Z");
  expect(asked).toBe(3);
  expect(store.getSetting("w", "wealth.quotes.retry") ?? "").toBe("");
  // Never longer than a day.
  answer = "throw";
  store.setSetting("w", "wealth.quotes.retry", JSON.stringify({ failures: 13, retryAt: "2026-11-11T00:00:00Z" }));
  await at("2026-11-11T00:00:00Z");
  expect(JSON.parse(store.getSetting("w", "wealth.quotes.retry")!)).toEqual({ failures: 14, retryAt: "2026-11-12T00:00:00.000Z" });
  store.close();
});

test("a workspace with no money and no accounts asks nothing of anyone", async () => {
  const store = new CrosslineStore(":memory:");
  let called = false;
  await wealthPricePass(store, "w", { fetchJson: async () => { called = true; return {}; } });
  expect(called).toBe(false);
  store.close();
});
