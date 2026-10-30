import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { CAMERA_ENERGY_CONSENT, SELF_SLEEP_SETTING, SETTING_CATALOG, SETTING_KEYS } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { executeAction } from "./actions";
import { conversationTurn, decideCard } from "./conversation";
import { effectiveSchedulePreferences } from "./crossline";
import { SETTING_HANDLERS } from "./setting-change";
import { undoOp } from "./undo";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); });

const NOW = new Date("2026-10-30T15:00:00.000Z");
const ws = TEST_CTX.workspaceId;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const worker = vi.mocked(requestCodexSupervisor);
const page = { kind: "today", entityId: "" };

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent: "ECE 555 作业 3", state: "approved", riskTier: "routine", estimate, payload: {} });
  return store;
}
/** The worker answers with these actions, the way the Skill would. */
const answer = (...actions: unknown[]) => worker.mockResolvedValue({ state: "replied", turn: { reply: "", confidence: "high", actions, clarify: { question: "", options: [] } } });
const say = async (text: string) => (await conversationTurn(TEST_CTX, { text, mentions: [], page }, NOW))[1]!;

test("every key of the catalog has a handler that calls the page's own function", () => {
  expect(Object.keys(SETTING_HANDLERS).sort()).toEqual([...SETTING_KEYS].sort());
});

test("a setting change waits on its card with 当前 → 改成, and runs only when the person confirms", async () => {
  const store = setup();
  answer({ action: "setting.change", summary: "推送改为少", args: { key: "notify.level", target: "", value: "less" } });
  const reply = await say("通知少一点");
  expect(reply.card?.items[0]).toMatchObject({ state: "pending", setting: { from: "标准", to: "少" } });
  expect(store.getSetting(ws, "notify.level")).toBeUndefined();
  await decideCard(TEST_CTX, reply.id, {}, NOW);
  expect(store.getSetting(ws, "notify.level")).toBe("less");
});

test("a packing number goes through the plan's own change and can be undone", async () => {
  setup();
  const done = await executeAction(TEST_CTX, { action: "setting.change", summary: "任务间隔 20 分钟", args: { key: "schedule.gapMinutes", target: "", value: "20" } });
  expect(done).toMatchObject({ ok: true });
  expect(effectiveSchedulePreferences(TEST_CTX).preferences.params?.gapMinutes).toBe(20);
  expect(done.ok && done.opId).toBeTruthy();
  undoOp(TEST_CTX, (done as { opId: string }).opId);
  expect(effectiveSchedulePreferences(TEST_CTX).preferences.params?.gapMinutes).not.toBe(20);
});

test("a setting about one object names it: a task's completion mode and a background kind", async () => {
  const store = setup();
  expect(await executeAction(TEST_CTX, { action: "setting.change", summary: "", args: { key: "task.completionMode", target: "hw", value: "needs_assessment" } })).toMatchObject({ ok: true });
  expect((store.getWorkOrder(ws, "hw")?.payload as { completionMode?: string }).completionMode).toBe("needs_assessment");
  expect(await executeAction(TEST_CTX, { action: "setting.change", summary: "", args: { key: "background.paused", target: "research", value: "paused" } })).toMatchObject({ ok: true });
  expect(await SETTING_HANDLERS["background.paused"].current(TEST_CTX, "research")).toBe("paused");
});

test("a consent is turned on and off through the box, its card carrying the settings card's own explanation; off deletes what it kept", async () => {
  const store = setup();
  answer({ action: "setting.change", summary: "开启摄像头精力采样", args: { key: "consent.camera", target: "", value: "on" } });
  const on = await say("打开摄像头精力采样");
  expect(on.card?.items[0]?.setting?.explain).toEqual([...SETTING_CATALOG["consent.camera"].explain]);
  await decideCard(TEST_CTX, on.id, {}, NOW);
  expect(store.getSetting(ws, CAMERA_ENERGY_CONSENT)).toBe("granted");
  store.saveEnergyObservation({ id: "cam-1", ownerId: TEST_CTX.principalId, workspaceId: ws, source: "camera_aggregate", level: "uncalibrated", confidence: "low",
    aggregate: {}, observedAt: NOW.toISOString() });
  answer({ action: "setting.change", summary: "关闭摄像头精力采样", args: { key: "consent.camera", target: "", value: "off" } });
  const off = await say("关掉摄像头");
  await decideCard(TEST_CTX, off.id, {}, NOW);
  expect(store.getSetting(ws, CAMERA_ENERGY_CONSENT)).toBe("denied");
  expect(store.listEnergyObservations(ws).filter((item) => item.source === "camera_aggregate")).toEqual([]);
});

test("each consent's explanation is word for word what its settings card shows", () => {
  const cards = ["energy-card.tsx", "local-activity-toggle.tsx", "agent-history-card.tsx", "recording-card.tsx", "server-recording-card.tsx"]
    .map((file) => readFileSync(new URL(`../app/settings/${file}`, import.meta.url), "utf8")).join("\n");
  for (const key of SETTING_KEYS) for (const line of (SETTING_CATALOG[key] as { explain?: readonly string[] }).explain ?? []) expect(cards).toContain(line);
});

test("a night's sleep is written at once, read by the energy model's sources, and undone with 撤销", async () => {
  const store = setup();
  answer({ action: "sleep.report", summary: "昨晚 1:00 睡，8:00 起", args: { wakeDate: "2026-10-30", sleepTime: "01:00", wakeTime: "08:00" } });
  const reply = await say("昨晚一点睡八点起");
  const item = reply.card!.items[0]!;
  expect(item).toMatchObject({ state: "done" });
  const nights = JSON.parse(store.getSetting(ws, SELF_SLEEP_SETTING) ?? "[]") as Array<{ source: string }>;
  expect(nights).toEqual([expect.objectContaining({ source: "self_report" })]);
  expect(undoOp(TEST_CTX, item.opId!)).toMatchObject({ ok: true });
  expect(store.getSetting(ws, SELF_SLEEP_SETTING)).toBeUndefined();
});

test("minutes reported on a task are a closed session; undo takes the session back", async () => {
  const store = setup();
  answer({ action: "task.op", summary: "作业 3 做了 40 分钟", args: { workOrderId: "hw", type: "progress", date: "", minutes: 40, stepId: "", text: "做了第一题", who: "", energy: "", outcome: "" } });
  const reply = await say("作业 3 做了 40 分钟，第一题写完了");
  const item = reply.card!.items[0]!;
  expect(item.state).toBe("done");
  const sessions = () => store.listExecutions(ws, "hw").filter((execution) => String(execution.outcome) === "confirmed");
  expect(sessions()).toHaveLength(1);
  undoOp(TEST_CTX, item.opId!);
  expect(sessions()).toHaveLength(0);
});

test("a task reported finished is completed at once and reopened by 撤销", async () => {
  const store = setup();
  answer({ action: "task.op", summary: "作业 3 已完成，用时 2 小时", args: { workOrderId: "hw", type: "complete", date: "", minutes: 120, stepId: "", text: "", who: "", energy: "", outcome: "smooth" } });
  const item = (await say("作业 3 写完了，用了两小时")).card!.items[0]!;
  expect(store.getWorkOrder(ws, "hw")?.state).toBe("accepted");
  undoOp(TEST_CTX, item.opId!);
  expect(store.getWorkOrder(ws, "hw")?.state).toBe("approved");
});

test("a credential is never repeated: the pasted key is cut out before it is kept or sent, and the card links to the settings card", async () => {
  const store = setup();
  answer({ action: "settings.open", summary: "在设置里填写邮箱密码", args: { section: "mail", topic: "邮箱密码" } });
  const [person, reply] = await conversationTurn(TEST_CTX, { text: "我的邮箱密码是 hunter2pass 帮我连上", mentions: [], page }, NOW);
  expect(person!.text).not.toContain("hunter2pass");
  expect(String(worker.mock.calls[0]![2]?.body)).not.toContain("hunter2pass");
  expect(reply!.card?.items[0]).toMatchObject({ state: "done", href: "/settings#mail" });
  expect(store.listEvents(ws, { type: "op.applied" })).toEqual([]);
});
