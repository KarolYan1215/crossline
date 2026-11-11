import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

const account = { id: "a1", name: "招行储蓄", accountClass: "cash" as const, currency: "CNY", note: "", archivedAt: "", createdAt: "2026-11-01T00:00:00Z" };

test("accounts, one balance per day, positions per symbol; exported with the workspace, prices never", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWealthAccount("w", account);
  store.saveWealthAccount("w", { ...account, name: "招行" });
  expect(store.listWealthAccounts("w").map((item) => item.name)).toEqual(["招行"]);
  store.saveWealthSnapshot("w", { id: "s1", accountId: "a1", on: "2026-11-01", value: 100, source: "person", createdAt: "2026-11-01T09:00:00Z" });
  // A second balance the same day replaces the first and keeps its id.
  store.saveWealthSnapshot("w", { id: "s2", accountId: "a1", on: "2026-11-01", value: 120, source: "assistant", createdAt: "2026-11-01T10:00:00Z" });
  expect(store.listWealthSnapshots("w")).toEqual([{ id: "s1", accountId: "a1", on: "2026-11-01", value: 120, source: "assistant", createdAt: "2026-11-01T10:00:00Z" }]);
  store.saveWealthHolding("w", { id: "h1", accountId: "a1", symbol: "AAPL.US", quantity: 3, price: 0, priceCurrency: "", priceOn: "", updatedAt: "x" });
  store.saveWealthHolding("w", { id: "h2", accountId: "a1", symbol: "AAPL.US", quantity: 5, price: 0, priceCurrency: "", priceOn: "", updatedAt: "y" });
  expect(store.listWealthHoldings("w").map((item) => [item.id, item.quantity])).toEqual([["h1", 5]]);
  expect(store.listWealthAccounts("other")).toEqual([]);

  store.saveMarketPrices([{ kind: "fx", symbol: "USD", day: "2026-11-09", price: 1.1, currency: "EUR", source: "frankfurter", fetchedAt: "t" }]);
  store.saveMarketPrices([{ kind: "fx", symbol: "USD", day: "2026-11-09", price: 1.2, currency: "EUR", source: "frankfurter", fetchedAt: "t2" }]);
  expect(store.listMarketPrices({ kinds: ["fx"] }).map((row) => row.price)).toEqual([1.2]);
  expect(store.listMarketPrices({ kinds: ["quote"] })).toEqual([]);

  const tables = store.exportSnapshot("w").tables;
  expect(tables.wealth_accounts).toHaveLength(1);
  expect(tables.wealth_snapshots).toHaveLength(1);
  expect(tables.wealth_holdings).toHaveLength(1);
  expect(tables.market_prices).toBeUndefined();

  // Removing the account takes its balances and positions with it.
  expect(store.deleteWealthRow("w", "wealth_accounts", "a1")).toBe(true);
  expect([store.listWealthSnapshots("w"), store.listWealthHoldings("w")]).toEqual([[], []]);
  store.close();
});

test("a snapshot with wealth rows restores into an empty database", () => {
  const source = new CrosslineStore(":memory:");
  source.saveWealthAccount("w", account);
  source.saveWealthSnapshot("w", { id: "s1", accountId: "a1", on: "2026-11-01", value: 100, source: "person", createdAt: "2026-11-01T09:00:00Z" });
  const snapshot = source.exportSnapshot("w");
  const target = new CrosslineStore(":memory:");
  target.importSnapshot(snapshot);
  expect(target.listWealthSnapshots("w").map((item) => item.value)).toEqual([100]);
  source.close(); target.close();
});
