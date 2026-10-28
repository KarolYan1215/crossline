import { monthlyLimitFrom, monthlyMoneyReport, weeklyMoneyReport, type LedgerRecord } from "@crossline/core";
import { settleStaleDuplicates, type CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";
import { tOfWorkspace } from "./locale";
import { sayToPerson } from "./workflow-smith";

export const MONEY_WEEKLY_KIND = "money_weekly";
export const MONEY_MONTHLY_KIND = "money_monthly";
/** From this local hour on Monday (the week) and the 1st (the month) the report goes out; never at night. */
const REPORT_HOUR = 8;

const zoneOf = (store: CrosslineStore, workspaceId: string) => {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  return zone;
};
const localParts = (now: Date, zone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: parts.weekday as string };
};
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const money = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The wealth line's monthly spending limit, from its approved milestones. */
export function monthlyLimit(store: CrosslineStore, workspaceId: string): number | null {
  const line = identityLines(store, workspaceId).find((item) => item.domain === "wealth");
  if (!line) return null;
  return monthlyLimitFrom(store.listMilestones(workspaceId).filter((milestone) => milestone.identityId === line.id && milestone.status === "approved")
    .flatMap((milestone) => milestone.successCriteria));
}

/**
 * The weekly and monthly spending reports (docs/mail-bookkeeping.md §5.3): on Monday from 08:00 in the person's zone, last week; on the 1st,
 * last month. Numbers from the ledger by code, no model; nothing sent for a period with no record; each period once (`money.report.*`).
 * Said as a reminder (the bell and the phone), which 「少问这类」 mutes like any other kind.
 */
export function moneyReportPass(store: CrosslineStore, workspaceId: string, now = new Date()): { weekly: boolean; monthly: boolean } {
  settleStaleDuplicates(store, workspaceId, now);
  const local = localParts(now, zoneOf(store, workspaceId));
  const sent = { weekly: false, monthly: false };
  if (local.hour < REPORT_HOUR) return sent;
  const records = store.listRecords(workspaceId, { domain: "wealth", since: addDays(local.day, -400) }) as LedgerRecord[];
  if (!records.length) return sent;
  const t = tOfWorkspace(store, workspaceId);
  const open = (path: string) => [{ label: t("看总账"), href: path }, { label: t("少问这类"), kind: "mute" as const }];
  if (local.weekday === "Mon") {
    const start = addDays(local.day, -7);
    const marker = `money.report.week:${start}`;
    const report = store.getSetting(workspaceId, marker) ? null : weeklyMoneyReport(records, start);
    store.setSetting(workspaceId, marker, now.toISOString());
    if (report && (report.spent > 0 || report.top.length)) {
      const parts = [t("上周花了 {{spent}} {{currency}}", { spent: money(report.spent), currency: report.currency })];
      if (report.changePct !== null) parts.push(report.changePct >= 0 ? t("比近四周平均多 {{pct}}%", { pct: Math.round(report.changePct) }) : t("比近四周平均少 {{pct}}%", { pct: Math.round(-report.changePct) }));
      let text = `${parts.join(t("，"))}${t("。")}`;
      if (report.top.length) text += t("最多的是{{list}}。", { list: report.top.map((item) => t("{{category}} {{amount}}", { category: t(item.category), amount: money(item.amount) })).join(t("、")) });
      if (report.largest) text += t("最大一笔：{{merchant}} {{amount}}。", { merchant: report.largest.merchant, amount: money(report.largest.amount) });
      if (report.newRecurring.length) text += t("新出现的周期扣费：{{list}}。", { list: report.newRecurring.map((item) => t("{{merchant}} 每次 {{amount}} {{currency}}", { merchant: item.merchant, amount: money(item.amount), currency: item.currency })).join(t("、")) });
      sayToPerson(store, workspaceId, text, MONEY_WEEKLY_KIND, marker, open(`/ledger?month=${start.slice(0, 7)}`), now);
      sent.weekly = true;
    }
  }
  if (local.day.endsWith("-01")) {
    const month = addDays(local.day, -1).slice(0, 7);
    const marker = `money.report.month:${month}`;
    const report = store.getSetting(workspaceId, marker) ? null : monthlyMoneyReport(records, month, monthlyLimit(store, workspaceId));
    store.setSetting(workspaceId, marker, now.toISOString());
    if (report) {
      const head = t("{{month}} 月花了 {{spent}} {{currency}}，收入 {{income}}", { month: Number(month.slice(5, 7)), spent: money(report.spent), currency: report.currency, income: money(report.income) });
      let text = report.savingsRate !== null ? `${head}${t("，储蓄率 {{rate}}%", { rate: Math.round(report.savingsRate) })}${t("。")}` : `${head}${t("。")}`;
      if (report.changePct !== null) text += report.changePct >= 0 ? t("比上月多花 {{pct}}%。", { pct: Math.round(report.changePct) }) : t("比上月少花 {{pct}}%。", { pct: Math.round(-report.changePct) });
      const movers = report.movers.filter((item) => item.change !== 0);
      if (movers.length) text += t("变化最大的：{{list}}。", { list: movers.map((item) => t("{{category}} {{change}}", { category: t(item.category), change: `${item.change > 0 ? "+" : ""}${money(item.change)}` })).join(t("、")) });
      if (report.subscriptionsAnnual > 0) text += t("周期扣费合计每年约 {{amount}}。", { amount: money(report.subscriptionsAnnual) });
      if (report.overLimit !== null) text += report.overLimit > 0 ? t("超出月度上限 {{amount}}。", { amount: money(report.overLimit) }) : t("在月度上限内，还剩 {{amount}}。", { amount: money(-report.overLimit) });
      sayToPerson(store, workspaceId, text, MONEY_MONTHLY_KIND, marker, open(`/ledger?month=${month}`), now);
      sent.monthly = true;
    }
  }
  return sent;
}
