import { describe, expect, it } from "vitest";
import { ledgerCategory, ledgerSummary, monthlyMoneyReport, recurringCharges, spendingAnomalies, weeklyMoneyReport, type LedgerRecord } from "./ledger";
import { recordMetrics } from "./records";

let n = 0;
const rec = (at: string, value: number, over: Partial<LedgerRecord> = {}): LedgerRecord =>
  ({ id: `r${n++}`, kind: "expense", at, value, currency: "USD", category: "餐饮", note: "", merchantKey: "cafe", account: "", status: "booked", ...over });

describe("the ledger's month", () => {
  const records = [
    rec("2026-09-05", 100), rec("2026-09-20", 200, { category: "购物", merchantKey: "shop" }),
    rec("2026-10-03", 50), rec("2026-10-10", 120, { category: "购物", merchantKey: "shop" }), rec("2026-10-12", 20, { kind: "refund", category: "购物", merchantKey: "shop" }),
    rec("2026-10-01", 3000, { kind: "income", category: "工资", merchantKey: "" }),
    rec("2026-10-15", 999, { status: "pending_review" }), rec("2026-10-16", 500, { currency: "CNY" })
  ];
  const summary = ledgerSummary(records, { today: "2026-10-28" });

  it("spending is net of refunds; income is only income; a possible duplicate and another currency are not summed", () => {
    expect(summary.currency).toBe("USD");
    expect(summary.spent).toBe(150);
    expect(summary.income).toBe(3000);
    expect(summary.savingsRate).toBe(95);
    expect(summary.others).toEqual([{ currency: "CNY", spent: 500, income: 0 }]);
    expect(summary.categories.find((item) => item.category === "购物")).toEqual({ category: "购物", amount: 100, lastMonth: 200 });
  });

  it("the pace compares to the same day of last month, and the cumulative line ends today", () => {
    expect(summary.pace).toEqual({ day: 28, lastMonthToDay: 300, changePct: -50 });
    expect(summary.cumulative.thisMonth).toHaveLength(28);
    expect(summary.cumulative.thisMonth.at(-1)).toBe(150);
    expect(summary.months).toHaveLength(12);
    expect(summary.days.find((item) => item.day === "2026-10-12")!.amount).toBe(-20);
  });

  it("the line card's numbers agree", () => {
    expect(recordMetrics(records, "2026-10-28")).toMatchObject({ expense: 150, income: 3000 });
  });
});

describe("recurring charges", () => {
  it("three monthly charges are a subscription with its yearly cost and next date; a rise is said", () => {
    const records = [rec("2026-07-15", 15.99, { merchantKey: "netflix", category: "订阅与软件" }), rec("2026-08-15", 15.99, { merchantKey: "netflix" }),
      rec("2026-09-15", 15.99, { merchantKey: "netflix" })];
    const [first] = recurringCharges(records, "2026-10-01");
    expect(first).toMatchObject({ merchant: "netflix", cycle: "monthly", annual: 191.88, next: "2026-10-15", priceUp: false });
    const risen = recurringCharges([...records, rec("2026-10-15", 17.99, { merchantKey: "netflix" })], "2026-10-20")[0]!;
    expect(risen).toMatchObject({ amount: 17.99, priceUp: true });
  });

  it("two charges a month apart are not yet a subscription, and one long stopped is not listed", () => {
    expect(recurringCharges([rec("2026-08-15", 9, { merchantKey: "x" }), rec("2026-09-15", 9, { merchantKey: "x" })], "2026-09-20")).toEqual([]);
    const old = [rec("2026-01-15", 9, { merchantKey: "x" }), rec("2026-02-15", 9, { merchantKey: "x" }), rec("2026-03-15", 9, { merchantKey: "x" })];
    expect(recurringCharges(old, "2026-10-01")).toEqual([]);
  });
});

describe("anomalies and reports", () => {
  it("a charge three times the merchant's usual is flagged", () => {
    const records = [rec("2026-09-01", 10), rec("2026-09-08", 11), rec("2026-09-15", 10), rec("2026-10-20", 45)];
    expect(spendingAnomalies(records, "2026-10-28")).toMatchObject([{ reason: "large_for_merchant", value: 45 }]);
  });

  it("a week with no record has no report; a week compares to the four before", () => {
    expect(weeklyMoneyReport([rec("2026-10-01", 10)], "2026-10-19")).toBeNull();
    const records = [rec("2026-10-19", 30, { category: "交通", merchantKey: "uber" }), rec("2026-10-21", 70), ...["2026-10-13", "2026-10-06", "2026-09-29", "2026-09-22"].map((day) => rec(day, 50))];
    const report = weeklyMoneyReport(records, "2026-10-19")!;
    expect(report).toMatchObject({ spent: 100, average4: 50, changePct: 100, largest: { merchant: "cafe", amount: 70 } });
    expect(report.top.map((item) => item.category)).toEqual(["餐饮", "交通"]);
  });

  it("the month's report says the limit's margin", () => {
    const report = monthlyMoneyReport([rec("2026-09-10", 300), rec("2026-10-10", 450)], "2026-10", 400)!;
    expect(report).toMatchObject({ spent: 450, lastMonthSpent: 300, changePct: 50, overLimit: 50 });
    expect(monthlyMoneyReport([rec("2026-09-10", 300)], "2026-10")).toBeNull();
  });
});

describe("categories written before the fixed lists", () => {
  it("reads free text as the merchant's plain category or 其他, never as a category of its own", () => {
    expect(ledgerCategory({ kind: "expense", category: "Apple" })).toBe("其他");
    expect(ledgerCategory({ kind: "expense", category: "Uber" })).toBe("交通");
    expect(ledgerCategory({ kind: "expense", category: "订阅与软件" })).toBe("订阅与软件");
    expect(ledgerCategory({ kind: "income", category: "bonus" })).toBe("其他收入");
    expect(ledgerSummary([rec("2026-10-24", 11.99, { category: "Apple" })], { today: "2026-10-28" }).categories.map((item) => item.category)).toEqual(["其他"]);
  });
});
