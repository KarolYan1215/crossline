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
  expect(planned[0]!.body).toContain("4 项待决定");
  expect(planned.filter((item) => item.kind === "urgent").map((item) => item.title)).toEqual(["师兄的真实测量数据到了吗？", "明天到期：实测 MoS₂ 参数可驱动 NeuroSim"]);
});

test("nothing before the day starts, nothing twice, a daily cap, and nothing at all when off", () => {
  expect(planNotifications({ ...base, clock: "07:30" })).toEqual([]);
  const sent = new Set(planNotifications(base).map((item) => item.key));
  expect(planNotifications({ ...base, sent, clock: "10:00" })).toEqual([]);
  expect(planNotifications({ ...base, level: "less" }).map((item) => item.kind)).toEqual(["brief"]);
  expect(planNotifications({ ...base, urgentSentToday: 2, sent: new Set(["brief:2026-10-08"]) })).toEqual([]);
  expect(planNotifications({ ...base, level: "off" })).toEqual([]);
  // The brief is a morning thing: not sent for the first time at 20:12.
  expect(planNotifications({ ...base, clock: "20:12", weekday: 4, windows: [...windows, { days: [4], start: "19:30", end: "23:00", energy: "high" }] })
    .filter((item) => item.kind === "brief")).toEqual([]);
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

// One definition of "needs you": when the web's snapshot is fresh, its asks are what interrupt, and only the ones that
// would cost a deadline within two days. A gate whose run failed is not announced as a verdict on the work.
test("with the web's asks, only those two days from a deadline interrupt, and they share the daily cap", () => {
  const asks = [{ id: "bp:e:m1", title: "「MoS₂」还缺：实测数据", urgency: "now" as const, path: "/" },
    { id: "cap:c:0", title: "「整理意见」没能自动拆解", urgency: "later" as const, path: "/approvals#asks" }];
  const planned = planNotifications({ ...base, asks });
  expect(planned[0]!.body).toContain("待决：「MoS₂」还缺：实测数据");
  expect(planned.filter((item) => item.kind === "urgent").map((item) => item.title))
    .toEqual(["「MoS₂」还缺：实测数据", "明天到期：实测 MoS₂ 参数可驱动 NeuroSim"]);
  expect(planNotifications({ ...base, waitingDue: [], dueSoon: [], gateRefusals: [{ id: "g", title: "仿真", message: "SKILL_UNAUTHENTICATED" }] })
    .filter((item) => item.kind === "urgent").map((item) => item.title)).toEqual(["验收没跑成：仿真"]);
});

test("a pass reads the web's snapshot while it is fresh and its own reading once it is stale", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "schedule.availability", JSON.stringify(windows));
  const now = new Date("2026-10-08T14:10:00Z");
  store.setSetting("w", "attention.snapshot", JSON.stringify({ at: new Date(now.getTime() - 5 * 60_000).toISOString(), pending: 7,
    asks: [{ id: "risk:m", title: "「MoS₂」可能赶不上 10/9", urgency: "now", path: "/" }] }));
  const shown: Array<[string, string]> = [];
  await notifyPass(store, "w", now, async (title, body) => { shown.push([title, body]); return true; });
  expect(shown[0]![1]).toContain("7 项待决定");
  expect(shown.map(([title]) => title)).toContain("「MoS₂」可能赶不上 10/9");
});

test("each message also goes to the phone, and counts as sent if only the phone got it", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "schedule.availability", JSON.stringify(windows));
  const pushed: string[] = [];
  const now = new Date("2026-10-08T14:10:00Z");
  const sent = await notifyPass(store, "w", now, async () => false, "http://127.0.0.1:3210",
    async (_ws, message) => { pushed.push(`${message.title}|${message.path}`); return true; });
  expect(pushed[0]).toBe("今天的 Crossline|/");
  expect(sent).toEqual(["brief:2026-10-08"]);
  expect(store.listEvents("w", { type: "notification.sent" })).toHaveLength(1);
});

test("the system's own messages go to the desktop only while no page is in front of the person, each once", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "notify.level", "off");
  const conversation = store.conversationFor("w", "2026-10-12");
  const now = new Date("2026-10-12T13:52:00.000Z");
  store.appendConversationMessage({ id: "n1", workspaceId: "w", conversationId: conversation.id, role: "nudge", text: "", createdAt: "2026-10-12T13:50:00.000Z",
    payload: { nudge: { kind: "block_start", fingerprint: "start:b:2026-10-12", counted: false, urgent: true, delivery: "pending" },
      card: { clarify: { question: "09:00 做「完成 ECE 555 作业 2」（45 分），关系到 10/14 的截止。", options: [] } } } });
  const shown: string[] = [];
  const deliver = async (_title: string, body: string) => { shown.push(body); return true; };
  store.setSetting("w", "presence.visibleAt", "2026-10-12T13:51:00.000Z");
  expect(await notifyPass(store, "w", now, deliver)).toEqual([]);
  store.setSetting("w", "presence.visibleAt", "2026-10-12T13:30:00.000Z");
  expect(await notifyPass(store, "w", now, deliver)).toEqual(["nudge:start:b:2026-10-12"]);
  expect(await notifyPass(store, "w", now, deliver)).toEqual([]);
  expect(shown).toEqual(["09:00 做「完成 ECE 555 作业 2」（45 分），关系到 10/14 的截止。"]);
  expect(store.getConversationMessage("w", "n1")!.payload.nudge).toMatchObject({ delivery: "pushed" });
  store.close();
});

test("a nudge whose button starts a task reaches the phone with that task, so 「开始计时」 is one tap there too", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "notify.level", "off");
  const conversation = store.conversationFor("w", "2026-10-12");
  store.appendConversationMessage({ id: "n1", workspaceId: "w", conversationId: conversation.id, role: "nudge", text: "", createdAt: "2026-10-12T13:50:00.000Z",
    payload: { nudge: { kind: "block_start", fingerprint: "start:b:2026-10-12", counted: false, urgent: true, delivery: "pending" },
      card: { actions: [{ action: "task.op", summary: "开始", args: { workOrderId: "wo-7", type: "start" } }],
        clarify: { question: "09:00 做「作业 2」。", options: [] } } } });
  const pushed: Array<{ path: string; start?: string }> = [];
  await notifyPass(store, "w", new Date("2026-10-12T13:52:00.000Z"), async () => false, undefined, async (_ws, message) => { pushed.push(message); return true; });
  expect(pushed).toMatchObject([{ path: "/workbench/wo-7", start: "wo-7" }]);
  store.close();
});

test("a completion check goes to the desktop and the phone even with a page open, opening its confirm page, with no 「开始计时」", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "notify.level", "off");
  store.setSetting("w", "presence.visibleAt", "2026-10-12T15:51:00.000Z");
  const conversation = store.conversationFor("w", "2026-10-12");
  store.appendConversationMessage({ id: "c1", workspaceId: "w", conversationId: conversation.id, role: "nudge", text: "", createdAt: "2026-10-12T15:47:00.000Z",
    payload: { nudge: { kind: "block_confirm", fingerprint: "confirm:scheduled:hw3:v1s1:2026-10-12", counted: true, urgent: true, delivery: "pending" },
      card: { actions: [], clarify: { question: "09:00–09:45 的「完成 ECE 555 作业 3」做得怎么样？", options: [{ label: "确认", actions: [], kind: "href", href: "/confirm/c1" }] } } } });
  const desktop: string[] = [];
  const pushed: Array<{ path: string; start?: string }> = [];
  const sent = await notifyPass(store, "w", new Date("2026-10-12T15:52:00.000Z"), async (_title, _body, url) => { desktop.push(url); return true; }, "http://127.0.0.1:3210",
    async (_ws, message) => { pushed.push(message); return true; });
  expect(sent).toEqual(["nudge:confirm:scheduled:hw3:v1s1:2026-10-12"]);
  expect(desktop).toEqual(["http://127.0.0.1:3210/confirm/c1"]);
  expect(pushed).toEqual([expect.objectContaining({ path: "/confirm/c1" })]);
  expect(pushed[0]).not.toHaveProperty("start");
  store.close();
});

test("the morning brief says how many of last night's blocks wait to be confirmed", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "nudge.blocks:2026-10-07", JSON.stringify({
    "scheduled:a": { id: "scheduled:a", end: "23:30", began: true },
    "scheduled:b": { id: "scheduled:b", end: "23:59", began: true },
    "scheduled:c": { id: "scheduled:c", end: "15:00", began: true },
    "scheduled:d": { id: "scheduled:d", end: "23:40", began: false } }));
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "block-confirmed:x", type: "block.confirmed", entityId: "x",
    payload: { blockId: "scheduled:b", day: "2026-10-07", outcome: "as_planned" } });
  const shown: string[] = [];
  await notifyPass(store, "w", new Date("2026-10-08T14:05:00.000Z"), async (_title, body) => { shown.push(body); return true; });
  expect(shown[0]).toContain("昨晚 1 块待确认");
  store.close();
});

test("away from the computer by the screen record, a nudge goes to the phone only, and to the desktop only when no phone takes it", async () => {
  const store = new CrosslineStore(":memory:");
  store.setSetting("w", "notify.level", "off");
  const nudge = (id: string) => store.appendConversationMessage({ id, workspaceId: "w", conversationId: store.conversationFor("w", "2026-10-12").id, role: "nudge", text: "",
    createdAt: "2026-10-12T13:50:00.000Z", payload: { nudge: { kind: "block_start", fingerprint: `start:${id}:2026-10-12`, counted: false, urgent: true, delivery: "pending" },
      card: { actions: [], clarify: { question: "09:00 做「作业 2」。", options: [] } } } });
  const now = new Date("2026-10-12T13:52:00.000Z");
  // Fifteen idle minutes on the screen record, kept under the detail consent.
  for (let minute = 16; minute >= 1; minute -= 1)
    store.recordActivityReading({ workspaceId: "w", at: new Date(now.getTime() - minute * 60_000).toISOString(), intervalSeconds: 60, app: "", title: "", category: "other", idle: true });
  const desktop: string[] = [], phone: string[] = [];
  const toDesktop = async (_title: string, body: string) => { desktop.push(body); return true; };
  nudge("a");
  // Without the consent the record is not read: both, as before.
  await notifyPass(store, "w", now, toDesktop, undefined, async (_ws, message) => { phone.push(message.body); return true; });
  expect([desktop.length, phone.length]).toEqual([1, 1]);
  store.setSetting("w", "localActivity.consentV2", "granted");
  nudge("b");
  await notifyPass(store, "w", now, toDesktop, undefined, async (_ws, message) => { phone.push(message.body); return true; });
  expect([desktop.length, phone.length]).toEqual([1, 2]);
  nudge("c");
  expect(await notifyPass(store, "w", now, toDesktop, undefined, async () => false)).toEqual(["nudge:start:c:2026-10-12"]);
  expect(desktop.length).toBe(2);
  store.close();
});
