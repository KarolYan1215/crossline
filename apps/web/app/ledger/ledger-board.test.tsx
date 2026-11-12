import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("next/navigation", async (original) => ({ ...await original<typeof import("next/navigation")>(), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
import { budgetPace, ledgerSummary, type LedgerRecord } from "@crossline/core";
import type { LedgerView } from "../../lib/ledger";
import { LedgerBoard } from "./ledger-board";

let n = 0;
const rec = (at: string, value: number, kind: LedgerRecord["kind"] = "expense"): LedgerRecord =>
  ({ id: `r${n++}`, kind, at, value, currency: "USD", category: kind === "income" ? "工资" : "餐饮", note: "", merchantKey: "", account: "", status: "booked" });

function view(records: LedgerRecord[], options: { spendingOnly?: boolean; cap?: number } = {}): LedgerView {
  const summary = ledgerSummary(records, { today: "2026-11-11", currency: "USD", limit: options.cap ?? null, spendingOnly: options.spendingOnly ?? false });
  return { today: "2026-11-11", month: "2026-11", months: ["2026-11"], hasRecords: true, summary, recurring: [], anomalies: [], rows: [], pending: [], rules: [],
    spendCategories: ["餐饮"], incomeCategories: ["工资"], fx: { base: "USD", rateDay: "", currencies: ["USD", "EUR"] },
    budget: { lines: [], limitFrom: options.cap ? "person" : null, own: { monthly: options.cap ?? null, currency: "USD", categories: {} },
      monthly: options.cap ? budgetPace(summary.spent, options.cap, 11, 30, true) : null, unconverted: false },
    spendingOnly: options.spendingOnly ?? false };
}
const spending = [rec("2026-11-02", 300), rec("2026-11-09", 250)];

test("one income entry: the page says income is not fully recorded instead of a savings rate or a net", () => {
  const html = renderToStaticMarkup(<LedgerBoard view={view([...spending, rec("2026-11-03", 42, "income")])} />);
  expect(html).toContain("<dt>收入</dt><dd class=\"lg-stat-note\">未记全（本月 1 笔）</dd>");
  expect(html).not.toContain("<dt>储蓄率</dt>");
  expect(html).not.toContain("<dt>净额</dt>");
  expect(html).not.toContain("月底预计");
});

test("只记开销: income is not shown however much is booked, and the setting says so", () => {
  const html = renderToStaticMarkup(<LedgerBoard view={view([...spending, rec("2026-11-01", 2000, "income"), rec("2026-11-08", 2000, "income")], { spendingOnly: true })} />);
  expect(html).toContain("不记（只记开销）");
  expect(html).not.toContain("<dt>储蓄率</dt>");
  expect(html).toContain("只记开销");
});

test("two income entries and no choice: the savings rate stands", () => {
  const html = renderToStaticMarkup(<LedgerBoard view={view([...spending, rec("2026-11-01", 2000, "income"), rec("2026-11-08", 2000, "income")])} />);
  expect(html).toContain("<dt>储蓄率</dt>");
  expect(html).toContain("86.25%");
});

test("a monthly budget: spent against it, what is left, and the pace against the days gone; over it, the alarm colour and the overrun", () => {
  const within = renderToStaticMarkup(<LedgerBoard view={view(spending, { cap: 1100 })} />);
  expect(within).toContain("剩 550");
  expect(within).toContain("到 11 日，预算按天数应花约 403.33，已花 550，多花 146.67");
  expect(within).toMatch(/lg-meter-fill" data-state="pace"/);
  const over = renderToStaticMarkup(<LedgerBoard view={view(spending, { cap: 500 })} />);
  expect(over).toContain("超出 50");
  expect(over).toMatch(/lg-meter-fill" data-state="over"/);
});
