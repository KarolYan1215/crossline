import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { moneyReportPass } from "./money-report";
import { MAIL_RECORDS_REPAIR, mailRecordsRepair } from "./mail-records-repair";

let store: CrosslineStore;
afterEach(() => store?.close());
const add = (workspaceId: string, at: string, value: number, over: Record<string, unknown> = {}) => store.addRecord(workspaceId, { domain: "wealth", kind: "expense", at, value,
  unit: "元", currency: "USD", category: "餐饮", note: "", source: "input", sourceRef: "", dedupeKey: `t:${at}:${value}:${Math.random()}`, ...over });
const utc = "UTC";

test("the weekly report goes out on Monday morning once, with nothing for an empty week; the monthly one on the 1st", () => {
  store = new CrosslineStore(":memory:");
  const { workspace } = store.createPrincipalWithWorkspace("u", "w");
  store.setSetting(workspace.id, "schedule.preferences", JSON.stringify({ timeZone: utc }));
  add(workspace.id, "2026-10-20", 30); add(workspace.id, "2026-10-22", 70, { category: "交通", merchantKey: "uber" });
  // Monday 07:00: too early. 09:00: once.
  expect(moneyReportPass(store, workspace.id, new Date("2026-10-26T07:00:00Z"))).toEqual({ weekly: false, monthly: false });
  expect(moneyReportPass(store, workspace.id, new Date("2026-10-26T09:00:00Z"))).toEqual({ weekly: true, monthly: false });
  expect(moneyReportPass(store, workspace.id, new Date("2026-10-26T10:00:00Z"))).toEqual({ weekly: false, monthly: false });
  const said = store.listRecentNudges(workspace.id, "2000-01-01");
  expect(said).toHaveLength(1);
  // A week with nothing recorded: no report.
  expect(moneyReportPass(store, workspace.id, new Date("2026-11-09T09:00:00Z")).weekly).toBe(false);
  expect(moneyReportPass(store, workspace.id, new Date("2026-11-01T09:00:00Z")).monthly).toBe(true);
});

test("old mail records are judged again once: a request is voided, a refund stops being income, a twin is merged", () => {
  store = new CrosslineStore(":memory:");
  const { workspace } = store.createPrincipalWithWorkspace("u", "w");
  store.setSetting(workspace.id, "mail.log", JSON.stringify([
    { accountId: "a", uid: 1, from: "service@paypal.com", subject: "Your $61.00 USD request expired", date: "2026-10-28", kind: "todo", title: "", at: "" },
    { accountId: "a", uid: 2, from: "shop", subject: "Refund issued", date: "2026-10-20", kind: "transaction", title: "", at: "" },
    { accountId: "a", uid: 3, from: "bank", subject: "You paid $20.00 at Cafe", date: "2026-10-21", kind: "transaction", title: "", at: "" },
    { accountId: "b", uid: 7, from: "bank", subject: "You paid $20.00 at Cafe", date: "2026-10-21", kind: "transaction", title: "", at: "" }]));
  add(workspace.id, "2026-10-28", 61, { source: "mail", sourceRef: "a::1" });
  add(workspace.id, "2026-10-20", 15, { kind: "income", source: "mail", sourceRef: "a::2" });
  add(workspace.id, "2026-10-21", 20, { source: "mail", sourceRef: "a::3" });
  add(workspace.id, "2026-10-21", 20, { source: "mail", sourceRef: "b::7" });
  add(workspace.id, "2026-10-21", 20, { source: "input" });
  expect(mailRecordsRepair(store, workspace.id)).toEqual({ voided: 1, refunds: 1, merged: 1 });
  // Records of one day and one creation time come back in either order.
  expect(store.listRecords(workspace.id).map((record) => [record.kind, record.value, record.source].join(" ")).sort())
    .toEqual(["expense 20 input", "expense 20 mail", "refund 15 mail"]);
  expect(store.getSetting(workspace.id, MAIL_RECORDS_REPAIR)).toBeTruthy();
  expect(mailRecordsRepair(store, workspace.id)).toEqual({ voided: 0, refunds: 0, merged: 0 });
});
