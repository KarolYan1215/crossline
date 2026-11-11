import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { cryptoRows, fxRows, verifiedQuotes, wealthPricePass } from "./wealth-prices";

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
  expect(urls.some((url) => url.includes("2026-11-01..2026-11-10"))).toBe(true);
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
  store.close();
});

test("a workspace with no money and no accounts asks nothing of anyone", async () => {
  const store = new CrosslineStore(":memory:");
  let called = false;
  await wealthPricePass(store, "w", { fetchJson: async () => { called = true; return {}; } });
  expect(called).toBe(false);
  store.close();
});
