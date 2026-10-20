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

test("a wellness line card shows the week's exercise and the latest weight, and says how records arrive when there are none", () => {
  const html = renderToStaticMarkup(<DomainRecords card={{ ...base, domain: "wellness", workouts: 3, workoutMinutes: 95, weight: { value: 71.2, at: "2026-10-19" }, recent: [] }} />);
  expect(html).toContain("近 7 天运动 3 次 · 95 分钟");
  expect(html).toContain("体重 71.2 kg（10-19）");
  expect(html).toContain("还没有记录");
});
