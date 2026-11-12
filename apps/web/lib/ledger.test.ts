import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { saveSchedulePreferences } from "./crossline";
import { loadLedger } from "./ledger";
import { applyWealthAction } from "./wealth";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const NOW = new Date("2026-11-11T18:00:00.000Z");
function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered", windows: [], importance: {} });
  expect(applyWealthAction(TEST_CTX, { action: "base_currency", currency: "USD" }).ok).toBe(true);
  const add = (at: string, value: number, kind: "expense" | "income" = "expense") => store.addRecord(TEST_CTX.workspaceId, { domain: "wealth", kind, at, value, unit: "USD", currency: "USD",
    category: kind === "income" ? "工资" : "餐饮", note: "", source: "input", sourceRef: "", dedupeKey: `t:${at}:${value}:${kind}` });
  return { store, add };
}

test("the walkthrough's month: one 42 USD transfer is not a month's income, so no savings rate and no projection from three days", () => {
  const { add } = setup();
  add("2026-11-02", 60); add("2026-11-05", 60); add("2026-11-09", 60); add("2026-11-03", 42, "income");
  const view = loadLedger(TEST_CTX);
  expect(view.summary).toMatchObject({ incomeTracked: false, incomeEntries: 1, savingsRate: null, projected: null });
  expect(view.spendingOnly).toBe(false);
  expect(view.budget.monthly).toBeNull();
});

test("a monthly budget in its own currency is read against spending, with what is left and the pace; 只记开销 hides income however much is booked", () => {
  const { store, add } = setup();
  store.saveMarketPrices([{ kind: "fx", symbol: "USD", day: "2026-11-10", price: 1.1, currency: "EUR", source: "frankfurter", fetchedAt: "2026-11-10T16:00:00Z" }]);
  add("2026-11-02", 300); add("2026-11-09", 250); add("2026-11-01", 2000, "income"); add("2026-11-08", 2000, "income");
  expect(applyWealthAction(TEST_CTX, { action: "budget", monthly: 1000, currency: "EUR", categories: {} }).ok).toBe(true);
  let view = loadLedger(TEST_CTX);
  expect(view.budget.own).toMatchObject({ monthly: 1000, currency: "EUR" });
  expect(view.budget.monthly).toEqual({ cap: 1100, spent: 550, left: 550, pct: 50, over: false, day: 11, expected: 403.33, ahead: 146.67 });
  expect(view.summary.savingsRate).toBe(86.25);
  expect(applyWealthAction(TEST_CTX, { action: "spending_only", on: true }).ok).toBe(true);
  view = loadLedger(TEST_CTX);
  expect(view).toMatchObject({ spendingOnly: true, summary: { incomeTracked: false, savingsRate: null } });
  expect(applyWealthAction(TEST_CTX, { action: "spending_only", on: false }).ok).toBe(true);
  expect(loadLedger(TEST_CTX).spendingOnly).toBe(false);
});
