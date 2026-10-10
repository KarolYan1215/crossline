import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTION_IDS } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { ACTION_HANDLERS, executeAction } from "./actions";
import { conversationTurn, decideCard, loadConversation, searchConversation } from "./conversation";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); });

const NOW = new Date("2026-10-08T12:52:00.000Z");
const ws = TEST_CTX.workspaceId;
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const worker = vi.mocked(requestCodexSupervisor);

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "sim", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent: "处理西湖 MoS₂ 实测数据", state: "approved", riskTier: "routine", estimate, payload: {} });
  store.saveWaitingItem({ id: "wait-sim-0", ownerId: TEST_CTX.principalId, workspaceId: ws, title: "西湖 MoS2 真实测量数据", who: "师兄", expectedAt: "2026-10-08",
    approximate: true, followUpAt: "2026-10-08", state: "open", blocks: ["sim"], source: "manual" });
  return store;
}

test("every action of the registry has a handler", () => {
  expect(Object.keys(ACTION_HANDLERS).sort()).toEqual([...ACTION_IDS].sort());
});

test("the failure of 2026-10-08, replayed: 「不等了」, then 「撤销刚刚的不等了」 becomes an undo card that reopens the wait — no task is created", async () => {
  const store = setup();
  const answered = await executeAction(TEST_CTX, { action: "ask.answer", summary: "不等了：西湖 MoS2 真实测量数据", args: { askId: "wait:wait-sim-0", optionId: "cancelled", fields: [] } });
  expect(answered).toMatchObject({ ok: true });
  expect(store.listWaitingItems(ws, { state: "open" })).toEqual([]);
  // The worker answers with the newest recent operation from the pack it was sent, the way the Skill is told to.
  worker.mockImplementation(async (_ctx, path, init) => {
    expect(path).toBe("/v1/conversation/turn");
    const body = JSON.parse(String(init?.body)) as { pack: { ops: Array<{ id: string }> }; snapshot: string };
    expect(body.snapshot).toContain("待决事项");
    return { state: "replied", turn: { reply: "撤销「不等了」后，等待项重新打开。", confidence: "high",
      actions: [{ action: "undo", summary: "撤销「不等了」", args: { opId: body.pack.ops[0]!.id } }], clarify: { question: "", options: [] } } };
  });
  const [person, reply] = await conversationTurn(TEST_CTX, { text: "撤销刚刚的不等了", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(person!.text).toBe("撤销刚刚的不等了");
  expect(reply!.card?.items).toEqual([{ state: "pending" }]);
  expect(store.listCaptures(ws)).toEqual([]);
  const decided = await decideCard(TEST_CTX, reply!.id, {}, NOW);
  expect(decided).toMatchObject({ ok: true, message: { card: { items: [{ state: "done" }] } } });
  expect(store.listWaitingItems(ws, { state: "open" }).map((item) => item.id)).toEqual(["wait-sim-0"]);
  // Deciding again changes nothing: the card's actions have run.
  await decideCard(TEST_CTX, reply!.id, {}, NOW);
  expect(store.listEvents(ws, { type: "op.undone" })).toHaveLength(1);
  expect(loadConversation(TEST_CTX).messages.map((message) => message.role)).toEqual(["person", "assistant"]);
  expect(searchConversation(TEST_CTX, "不等了").length).toBeGreaterThan(0);
});

test("a clarify option carries out its candidates and dismisses the others; a card can be dismissed whole", async () => {
  const store = setup();
  const due = { action: "task.op", summary: "截止改为 10/16", args: { workOrderId: "sim", type: "due", date: "2026-10-16", minutes: 0, stepId: "", text: "", who: "", energy: "" } };
  const note = { action: "note.add", summary: "记一笔", args: { text: "周五前要处理数据" } };
  worker.mockResolvedValue({ state: "replied", turn: { reply: "", confidence: "low", actions: [due, note],
    clarify: { question: "改截止，还是只记一笔？", options: [{ label: "改截止", actions: [0] }, { label: "只记一笔", actions: [1] }] } } });
  const [, reply] = await conversationTurn(TEST_CTX, { text: "数据周五前处理", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  const decided = await decideCard(TEST_CTX, reply!.id, { option: 0 }, NOW);
  expect(decided).toMatchObject({ ok: true, message: { card: { clarify: { chosen: 0 }, items: [{ state: "done" }, { state: "dismissed" }] } } });
  expect((store.listWorkOrders(ws).find((order) => order.id === "sim")!.payload as { dueDate?: string }).dueDate).toBe("2026-10-16");
  expect(await decideCard(TEST_CTX, reply!.id, { option: 1 }, NOW)).toEqual({ ok: false, code: "OPTION_NOT_AVAILABLE" });
});

test("with the model unreachable the words are kept and offered as a new task, which is created only on 执行", async () => {
  const store = setup();
  worker.mockRejectedValue(new Error("ECONNREFUSED"));
  const [, reply] = await conversationTurn(TEST_CTX, { text: "整理 ECE 548 错题", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(reply!.text).toContain("原话已保存");
  expect(store.listCaptures(ws)).toEqual([]);
  await decideCard(TEST_CTX, reply!.id, {}, NOW);
  expect(store.listCaptures(ws).map((capture) => capture.title)).toEqual(["整理 ECE 548 错题"]);
});

test("an action whose object is gone by the time it is confirmed fails with a reason and changes nothing", async () => {
  const store = setup();
  worker.mockResolvedValue({ state: "replied", turn: { reply: "", confidence: "high", clarify: { question: "", options: [] },
    actions: [{ action: "task.op", summary: "开始", args: { workOrderId: "sim", type: "start", date: "", minutes: 0, stepId: "", text: "", who: "", energy: "" } }] } });
  const [, reply] = await conversationTurn(TEST_CTX, { text: "开始处理数据", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  store.saveWorkOrder({ ...store.listWorkOrders(ws).find((order) => order.id === "sim")!, state: "archived" });
  const decided = await decideCard(TEST_CTX, reply!.id, {}, NOW);
  expect(decided).toMatchObject({ ok: true, message: { card: { items: [{ state: "failed" }] } } });
});

test("the pack says how much time work can use: the available hours minus fixed arrangements, not the whole empty day", async () => {
  setup();
  const { contextPack, conciergeSnapshot } = await import("./conversation");
  const pack = await contextPack(TEST_CTX, { kind: "today", entityId: "" }, NOW);
  // The default pattern: weekdays 09–12 and 14–18 (7 h), weekends 10–12 (2 h); 2026-10-08 is a Thursday.
  expect(pack.capacity.map((day) => day.availableMinutes)).toEqual([420, 420, 120, 120, 420, 420, 420]);
  expect(conciergeSnapshot(pack, NOW)).toContain("可用时段扣除固定安排");
});
