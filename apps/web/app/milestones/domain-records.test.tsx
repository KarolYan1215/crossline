import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DomainRecords, type DomainRecordsCard } from "./domain-records";

const base: DomainRecordsCard = { domain: "wealth", month: "2026-10", currency: "CNY", income: 12000, expense: 3600, savingsRate: 70,
  categories: [{ category: "房租", amount: 3000 }, { category: "餐饮", amount: 600 }], workouts: 0, workoutMinutes: 0, weight: null,
  recent: [{ id: "r1", kind: "expense", at: "2026-10-19", value: 35, unit: "元", currency: "CNY", category: "餐饮", source: "mail" }] };

test("a wealth line card shows the month's money, the largest categories and where each record came from", () => {
  const html = renderToStaticMarkup(<DomainRecords card={base} />);
  for (const text of ["10 月", "收入 12,000", "支出 3,600", "储蓄率 70%", "房租", "最近记录（1）", "邮件", "删除"]) expect(html).toContain(text);
});

const months = (...pairs: Array<[string, number, number]>) => pairs.map(([month, income, expense]) => ({ month, income, expense }));
const week = (start: string, workoutMinutes: number, weight: number | null) => ({ start, workouts: workoutMinutes ? 1 : 0, workoutMinutes, weight });

test("a wealth card draws six months of income and spending once two months hold anything, each bar naming its value", () => {
  const trends = { currency: "CNY", months: months(["2026-05", 0, 0], ["2026-06", 0, 0], ["2026-07", 0, 0], ["2026-08", 0, 0], ["2026-09", 11000, 9999], ["2026-10", 12000, 3600]), weeks: [] };
  const html = renderToStaticMarkup(<DomainRecords card={{ ...base, trends }} />);
  expect(html).toContain("近 6 个月：浅色收入，深色支出（CNY）");
  expect(html).toContain('title="9 月支出 9,999"');
  expect(html).toContain('title="10 月收入 12,000"');
  // One month alone is not a trend.
  const one = renderToStaticMarkup(<DomainRecords card={{ ...base, trends: { ...trends, months: months(["2026-09", 0, 0], ["2026-10", 12000, 3600]) } }} />);
  expect(one).not.toContain("近 6 个月");
});

test("a wellness card draws the weeks' exercise and the weight as a line, each only with two weeks of data", () => {
  const weeks = [week("2026-09-07", 0, null), week("2026-09-14", 0, null), week("2026-09-21", 0, null), week("2026-09-28", 0, null),
    week("2026-10-05", 25, null), week("2026-10-12", 40, 72), week("2026-10-19", 30, 71.8), week("2026-10-26", 0, null)];
  const html = renderToStaticMarkup(<DomainRecords card={{ ...base, domain: "wellness", recent: [], trends: { currency: "CNY", months: [], weeks } }} />);
  expect(html).toContain("近 8 周每周运动分钟");
  expect(html).toContain('title="10/12 起的一周：运动 1 次 · 40 分钟"');
  expect(html).toContain("体重 72 → 71.8 kg（2 周）");
  const oneWeight = renderToStaticMarkup(<DomainRecords card={{ ...base, domain: "wellness", recent: [], trends: { currency: "CNY", months: [], weeks: weeks.map((item, index) => index === 5 ? { ...item, weight: null } : item) } }} />);
  expect(oneWeight).toContain("近 8 周每周运动分钟");
  expect(oneWeight).not.toContain("kg（");
});

test("a wellness line card shows the week's exercise and the latest weight, and says how records arrive when there are none", () => {
  const html = renderToStaticMarkup(<DomainRecords card={{ ...base, domain: "wellness", workouts: 3, workoutMinutes: 95, weight: { value: 71.2, at: "2026-10-19" }, recent: [] }} />);
  expect(html).toContain("近 7 天运动 3 次 · 95 分钟");
  expect(html).toContain("体重 71.2 kg（10-19）");
  expect(html).toContain("还没有记录");
});
