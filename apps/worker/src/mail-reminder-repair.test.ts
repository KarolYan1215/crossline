import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MAIL_REMINDER_REPAIR, mailReminderRepair } from "./mail-reminder-repair";

let store: CrosslineStore;
afterEach(() => store?.close());
const estimate = { p25Minutes: 10, p50Minutes: 15, p85Minutes: 20, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("mail check to-dos nobody started become one reminder, once; work and other captures stay", () => {
  store = new CrosslineStore(":memory:");
  const { workspace, principal } = store.createPrincipalWithWorkspace("u", "w");
  const order = (id: string, intent: string, state = "approved") => store.saveWorkOrder({ id, ownerId: principal.id, workspaceId: workspace.id, identityId: "startup",
    projectId: "", milestoneId: "", intent, state: state as never, riskTier: "routine", estimate, payload: { title: intent } });
  order("cap-mail-a", "核实美国银行无卡交易");
  order("cap-mail-b", "核查 Render 公告涉及应用", "awaiting_plan_approval");
  order("cap-mail-c", "10/30 前交 ECE 555 HW4");
  order("cap-typed", "核查实验数据");
  expect(mailReminderRepair(store, workspace.id).sort()).toEqual(["cap-mail-a", "cap-mail-b"]);
  const states = new Map(store.listWorkOrders(workspace.id).map((item) => [item.id, item.state]));
  expect(states.get("cap-mail-a")).toBe("archived");
  expect(states.get("cap-mail-c")).toBe("approved");
  expect(states.get("cap-typed")).toBe("approved");
  expect(store.getSetting(workspace.id, MAIL_REMINDER_REPAIR)).toBeTruthy();
  expect(store.listRecentNudges(workspace.id, "2000-01-01").length).toBe(1);
  expect(mailReminderRepair(store, workspace.id)).toEqual([]);
});
