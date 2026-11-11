import { describe, expect, test } from "vitest";
import {
  accountValues, baseCurrencyFor, budgetLines, convertRecords, converterFrom, holdingPrice, netWorthOn, netWorthSeries, parseBudget, staleAccounts, valueHoldings, wealthProblem, QUOTE_MAX_AGE_DAYS,
  type MarketPrice, type WealthAccount, type WealthHolding, type WealthSnapshot
} from "./wealth";

const fx = (day: string, rates: Record<string, number>): MarketPrice[] =>
  Object.entries(rates).map(([symbol, price]) => ({ kind: "fx", symbol, day, price, currency: "EUR", source: "frankfurter", fetchedAt: `${day}T16:00:00Z` }));
const account = (id: string, accountClass: WealthAccount["accountClass"], currency = "CNY", extra: Partial<WealthAccount> = {}): WealthAccount =>
  ({ id, name: id, accountClass, currency, note: "", archivedAt: "", createdAt: "2026-01-01T00:00:00Z", ...extra });
const snap = (accountId: string, on: string, value: number): WealthSnapshot => ({ id: `${accountId}-${on}`, accountId, on, value, source: "person", createdAt: `${on}T09:00:00Z` });

describe("base currency", () => {
  test("from the time zone, else the language", () => {
    expect(baseCurrencyFor("Asia/Shanghai", "en")).toBe("CNY");
    expect(baseCurrencyFor("America/Chicago", "zh")).toBe("USD");
    expect(baseCurrencyFor("America/Toronto", "zh")).toBe("CAD");
    expect(baseCurrencyFor("Europe/Berlin", "zh")).toBe("EUR");
    expect(baseCurrencyFor("Europe/London", "zh")).toBe("GBP");
    expect(baseCurrencyFor("Asia/Hong_Kong", "zh")).toBe("HKD");
    expect(baseCurrencyFor("Mars/Base", "zh")).toBe("CNY");
    expect(baseCurrencyFor("", "en")).toBe("USD");
  });
});

describe("conversion", () => {
  const rates = converterFrom([...fx("2026-11-06", { USD: 1.08, CNY: 7.8 }), ...fx("2026-11-09", { USD: 1.1, CNY: 7.7 })]);
  test("any pair through the euro, at the nearest earlier day", () => {
    expect(rates.convert(110, "USD", "CNY", "2026-11-10")).toEqual({ value: 110 / 1.1 * 7.7, rateDay: "2026-11-09" });
    // A Sunday reads Friday's rate: the ECB publishes on working days only.
    expect(rates.convert(108, "USD", "EUR", "2026-11-08")).toEqual({ value: 100, rateDay: "2026-11-06" });
    expect(rates.latestDay).toBe("2026-11-09");
  });
  test("never a later day's rate: before the first cached day nothing converts; an unknown currency is not guessed", () => {
    expect(rates.convert(1.08, "USD", "EUR", "2025-01-01")).toBeNull();
    expect(rates.convert(1.08, "USD", "EUR", "2026-11-05")).toBeNull();
    expect(convertRecords([{ value: 11, currency: "USD", at: "2026-11-05" }], "CNY", rates).records).toEqual([{ value: 11, currency: "USD", at: "2026-11-05" }]);
    expect(rates.convert(10, "TWD", "CNY", "2026-11-10")).toBeNull();
    expect(rates.convert(10, "CNY", "CNY", "2026-11-10")).toEqual({ value: 10, rateDay: "" });
  });
  test("records restated in the base currency, an unconvertible one kept as it was", () => {
    const records = [{ id: "a", value: 11, currency: "USD", at: "2026-11-09" }, { id: "b", value: 5, currency: "TWD", at: "2026-11-09" }, { id: "c", value: 3, currency: "CNY", at: "2026-11-09" }];
    const out = convertRecords(records, "CNY", rates);
    expect(out.records.map((record) => [record.currency, record.value])).toEqual([["CNY", 77], ["TWD", 5], ["CNY", 3]]);
    expect(out.rateDay).toBe("2026-11-09");
  });
});

describe("net worth", () => {
  const rates = converterFrom(fx("2026-09-01", { USD: 1, CNY: 7 }));
  const accounts = [account("bank", "cash"), account("card", "credit_card"), account("ira", "retirement", "USD"), account("old", "cash", "CNY", { archivedAt: "2026-10-15T00:00:00Z" })];
  const snapshots = [snap("bank", "2026-09-30", 10_000), snap("bank", "2026-10-31", 12_000), snap("card", "2026-10-31", 2_000), snap("ira", "2026-09-15", 1_000), snap("old", "2026-09-30", 500)];
  test("assets minus what is owed, by class, in the base currency", () => {
    const point = netWorthOn(accounts, snapshots, rates, "CNY", "2026-11-10");
    expect(point).toMatchObject({ assets: 19_000, liabilities: 2_000, net: 17_000, byClass: { cash: 12_000, retirement: 7_000, credit_card: 2_000 }, unconverted: 0 });
  });
  test("the curve carries each account's last value to the month's end; an archived account drops out after its day", () => {
    const series = netWorthSeries(accounts, snapshots, rates, "CNY", "2026-11-10");
    expect(series.map((point) => [point.day, point.net])).toEqual([["2026-09-30", 17_500], ["2026-10-31", 17_000], ["2026-11-10", 17_000]]);
  });
  test("a currency with no rate is counted apart, never summed in its own unit", () => {
    const point = netWorthOn([account("tw", "cash", "TWD")], [snap("tw", "2026-10-01", 100)], rates, "CNY", "2026-11-10");
    expect(point).toMatchObject({ assets: 0, unconverted: 1 });
    expect(accountValues([account("tw", "cash", "TWD")], [snap("tw", "2026-10-01", 100)], rates, "CNY", "2026-11-10")[0]).toMatchObject({ native: 100, base: null, ageDays: 40 });
  });
  test("no snapshot, no curve", () => expect(netWorthSeries(accounts, [], rates, "CNY", "2026-11-10")).toEqual([]));
});

describe("holdings", () => {
  const rates = converterFrom(fx("2026-11-09", { USD: 1, HKD: 8 }));
  const broker = account("broker", "brokerage", "USD");
  const holding = (symbol: string, quantity: number, extra: Partial<WealthHolding> = {}): WealthHolding =>
    ({ id: symbol, accountId: "broker", symbol, quantity, price: 0, priceCurrency: "", priceOn: "", updatedAt: "2026-11-01T00:00:00Z", ...extra });
  const quote = (symbol: string, day: string, price: number, currency: string): MarketPrice => ({ kind: "quote", symbol, day, price, currency, source: "longbridge", fetchedAt: day });
  test("quantity × the latest quote, converted into the account's currency", () => {
    const prices = [...rates ? [] : [], quote("AAPL.US", "2026-11-07", 200, "USD"), quote("AAPL.US", "2026-11-09", 210, "USD"), quote("700.HK", "2026-11-09", 400, "HKD")];
    expect(valueHoldings(broker, [holding("AAPL.US", 10), holding("700.HK", 100)], prices, rates, "2026-11-10")).toEqual({ value: 2100 + 5000, priceDay: "2026-11-09" });
  });
  test("one unpriced holding leaves the total unknown rather than short", () => {
    expect(valueHoldings(broker, [holding("AAPL.US", 10), holding("NEW.US", 1)], [quote("AAPL.US", "2026-11-09", 210, "USD")], rates, "2026-11-10")).toBeNull();
  });
  test("the person's own price stands in when it is newer than any quote", () => {
    const own = holding("NEW.US", 2, { price: 5, priceCurrency: "USD", priceOn: "2026-11-10" });
    expect(holdingPrice(own, "brokerage", [quote("NEW.US", "2026-11-01", 4, "USD")], "2026-11-10")).toMatchObject({ price: 5, source: "person" });
    expect(holdingPrice({ ...own, priceOn: "2026-10-01" }, "brokerage", [quote("NEW.US", "2026-11-01", 4, "USD")], "2026-11-10")).toMatchObject({ price: 4, source: "longbridge" });
  });
  test(`a quote older than ${QUOTE_MAX_AGE_DAYS} days is shown as old and values nothing (a delisted symbol is not priced for ever)`, () => {
    const prices = [quote("GONE.US", "2026-10-20", 30, "USD"), quote("AAPL.US", "2026-11-09", 210, "USD")];
    expect(holdingPrice(holding("GONE.US", 1), "brokerage", prices, "2026-10-30")).toMatchObject({ price: 30, on: "2026-10-20", stale: false });
    expect(holdingPrice(holding("GONE.US", 1), "brokerage", prices, "2026-11-10")).toMatchObject({ price: 30, on: "2026-10-20", stale: true });
    expect(valueHoldings(broker, [holding("AAPL.US", 10), holding("GONE.US", 1)], prices, rates, "2026-11-10")).toBeNull();
    // The person's own price is their word, dated; it does not age out.
    const own = holding("GONE.US", 1, { price: 25, priceCurrency: "USD", priceOn: "2026-10-25" });
    expect(holdingPrice(own, "brokerage", prices, "2026-11-30")).toMatchObject({ price: 25, source: "person", stale: false });
  });
});

describe("the 更新余额 card", () => {
  test("lists hand-typed accounts with nothing since the month began", () => {
    const accounts = [account("bank", "cash"), account("card", "credit_card"), account("broker", "brokerage", "USD"), account("gone", "cash", "CNY", { archivedAt: "2026-10-01" })];
    const holdings: WealthHolding[] = [{ id: "h", accountId: "broker", symbol: "AAPL.US", quantity: 1, price: 0, priceCurrency: "", priceOn: "", updatedAt: "" }];
    expect(staleAccounts(accounts, [snap("bank", "2026-10-31", 1), snap("card", "2026-11-01", 1)], holdings, "2026-11").map((item) => item.id)).toEqual(["bank"]);
  });
});

describe("budgets", () => {
  test("each capped category against the month, projected at the pace so far", () => {
    const lines = budgetLines({ monthly: 5000, categories: { 餐饮: 1000, 交通: 300, 购物: 0 } }, [{ category: "餐饮", amount: 600 }, { category: "购物", amount: 50 }], 10, 30, true);
    expect(lines).toEqual([
      { category: "餐饮", cap: 1000, spent: 600, pct: 60, projected: 1800, over: false, projectedOver: true },
      { category: "交通", cap: 300, spent: 0, pct: 0, projected: 0, over: false, projectedOver: false }
    ]);
    expect(budgetLines({ monthly: null, categories: { 餐饮: 100 } }, [{ category: "餐饮", amount: 120 }], 31, 31, false)[0]).toMatchObject({ over: true, projected: null });
  });
  test("a malformed setting reads as no budget", () => {
    expect(parseBudget("{oops")).toEqual({ monthly: null, categories: {} });
    expect(parseBudget(JSON.stringify({ monthly: -1, categories: { 餐饮: 800, 交通: "x" } }))).toEqual({ monthly: null, categories: { 餐饮: 800 } });
  });
});

describe("entry checks", () => {
  test("balances, symbols and classes", () => {
    expect(wealthProblem({ accountClass: "cash", currency: "CNY", balance: 100, at: "2026-11-10" })).toBe("");
    expect(wealthProblem({ balance: -5 })).toMatch(/正数/);
    expect(wealthProblem({ accountClass: "brokerage", symbol: "AAPL", quantity: 1 })).toMatch(/AAPL\.US/);
    expect(wealthProblem({ accountClass: "brokerage", symbol: "AAPL.US", quantity: 1 })).toBe("");
    expect(wealthProblem({ accountClass: "crypto", symbol: "BTC", quantity: 0.5 })).toBe("");
    expect(wealthProblem({ accountClass: "cash", symbol: "BTC", quantity: 1 })).toMatch(/只有券商/);
    expect(wealthProblem({ accountClass: "house" })).toMatch(/类别/);
    expect(wealthProblem({ currency: "rmb" })).toMatch(/币种/);
  });
});
