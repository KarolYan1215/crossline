import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { notifyPass, planNotifications, type NotifyInput } from "./notify";

const windows = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" as const }, { days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", energy: "medium" as const }];
const base: NotifyInput = { today: "2026-10-08", clock: "09:05", weekday: 4, level: "normal", windows, sent: new Set(), urgentSentToday: 0,
  pending: 4, waitingDue: [{ id: "wait-1", who: "师兄", title: "真实测量数据" }],
  dueSoon: [{ id: "m1", title: "实测 MoS₂ 参数可驱动 NeuroSim", deadline: "2026-10-09", daysLeft: 1 }], gateRefusals: [] };

test("one morning brief at the first working hour, then single messages only for what would be missed today", () => {
  const planned = planNotifications(base);
  expect(planned[0]).toMatchObject({ kind: "brief", title: "今天的 Crossline" });
  expect(planned[0]!.body).toContain("今天该到：师兄的真实测量数据");
  expect(planned[0]!.body).toContain("4 件等你决定");
  expect(planned.filter((item) => item.kind === "urgent").map((item) => item.title)).toEqual(["师兄的真实测量数据到了吗？", "明天到期：实测 MoS₂ 参数可驱动 NeuroSim"]);
});

test("nothing before the day starts, nothing twice, a daily cap, and nothing at all when off", () => {
  expect(planNotifications({ ...base, clock: "07:30" })).toEqual([]);
  const sent = new Set(planNotifications(base).map((item) => item.key));
  expect(planNotifications({ ...base, sent, clock: "10:00" })).toEqual([]);
  expect(planNotifications({ ...base, level: "less" }).map((item) => item.kind)).toEqual(["brief"]);
  expect(planNotifications({ ...base, urgentSentToday: 2, sent: new Set(["brief:2026-10-08"]) })).toEqual([]);
  expect(planNotifications({ ...base, level: "off" })).toEqual([]);
  // Outside working hours, only the brief (if not yet sent) — no single messages at 21:00.
  expect(planNotifications({ ...base, clock: "21:00", sent: new Set(["brief:2026-10-08"]) })).toEqual([]);
});

test("a pass delivers and records each message once", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "schedule.availability", JSON.stringify(windows));
  store.saveWaitingItem({ id: "wait-1", ownerId: "o", workspaceId: "w", title: "真实测量数据", who: "师兄", expectedAt: "2026-10-08",
    approximate: true, followUpAt: "2026-10-08", state: "open", blocks: [], source: "analysis" });
  const shown: string[] = [];
  const deliver = async (title: string) => { shown.push(title); return true; };
  const now = new Date("2026-10-08T14:10:00Z"); // 09:10 in Chicago
  expect(await notifyPass(store, "w", now, deliver)).toEqual(["brief:2026-10-08", "waiting:wait-1:2026-10-08"]);
  expect(await notifyPass(store, "w", now, deliver)).toEqual([]);
  expect(shown).toEqual(["今天的 Crossline", "师兄的真实测量数据到了吗？"]);
  store.close();
});
