import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTION_IDS } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { ACTION_HANDLERS, executeAction } from "./actions";
import { conversationTurn, decideCard, loadConversation, pageTask, searchConversation } from "./conversation";
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

test("from a block picked on Today, 「这一步」 is that block's step while it is open; otherwise the first open step", () => {
  const steps = [{ id: "v1s1", title: "确定论证主线", status: "planned", minutes: 30, executor: "human" },
    { id: "v1s2", title: "整理方法对照表", status: "planned", minutes: 45, executor: "human" },
    { id: "v1s3", title: "写引言", status: "done", minutes: 30, executor: "human" }];
  const pack = (page: { stepId?: string }) => ({ page: { kind: "task", entityId: "wo-1", title: "撰写综述初稿", ...page },
    tasks: [{ id: "wo-1", title: "撰写综述初稿", line: "研究者", project: "", state: "approved", dueDate: "", notBefore: "", usualMinutes: 60, nextBlock: "", steps }] }) as never;
  const marked = (lines: string[]) => lines.find((line) => line.startsWith("- ▶"));
  expect(marked(pageTask(pack({ stepId: "v1s2" })))).toContain("v1s2");
  expect(marked(pageTask(pack({})))).toContain("v1s1");
  // A step already done is not 「这一步」: the first open one is.
  expect(marked(pageTask(pack({ stepId: "v1s3" })))).toContain("v1s1");
});

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
  // 12:52Z is 07:52 in Chicago: today's hours are all still ahead.
  expect(pack.capacity.map((day) => day.availableMinutes)).toEqual([420, 420, 120, 120, 420, 420, 420]);
  // At 22:15 on that Thursday nothing of today is left.
  const late = await contextPack(TEST_CTX, { kind: "today", entityId: "" }, new Date("2026-10-09T03:15:00.000Z"));
  expect(late.capacity[0]).toMatchObject({ day: "2026-10-08", availableMinutes: 0 });
  expect(conciergeSnapshot(pack, NOW)).toContain("可用时段扣除固定安排");
});

const dueOn = (date: string, workOrderId = "sim") => ({ action: "task.op", summary: `截止改为 ${date}`, args: { workOrderId, type: "due", date, minutes: 0, stepId: "", text: "", who: "", energy: "" } });
const replied = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ state: "replied", turn: { reply: "", confidence: "high", actions, clarify: { question: "", options: [] }, corrects: false, ...extra } });
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

test("先快后准: an unsure reading is shown at once, cannot run while the stronger model looks again, and is replaced by what it returns", async () => {
  setup();
  const bodies: Array<Record<string, unknown>> = [];
  worker.mockImplementation(async (_ctx, _path, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return body.review ? replied([dueOn("2026-10-16")], { reply: "核对后改为 10/16" }) : replied([dueOn("2026-10-15")], { confidence: "low" });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = worker.getMockImplementation()!;
  worker.mockImplementation(async (...args) => { const body = JSON.parse(String(args[2]?.body)); if (body.review) await gate; return original(...args); });
  const [, reply] = await conversationTurn(TEST_CTX, { text: "数据处理截止改到下周四还是周五", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(reply!.card).toMatchObject({ reviewing: true });
  expect(await decideCard(TEST_CTX, reply!.id, {}, NOW)).toEqual({ ok: false, code: "CARD_REVIEWING" });
  release();
  await settle();
  const after = loadConversation(TEST_CTX).messages.find((message) => message.id === reply!.id)!;
  expect(after.card?.reviewing).toBeFalsy();
  expect(after.card).toMatchObject({ reviewed: true, revised: true, actions: [{ args: { date: "2026-10-16" } }] });
  expect(after.text).toBe("核对后改为 10/16");
  expect(bodies.filter((body) => body.review)).toHaveLength(1);
  // A sure, single-object reading is not looked at twice.
  worker.mockResolvedValue(replied([dueOn("2026-10-20")]));
  const [, sure] = await conversationTurn(TEST_CTX, { text: "截止改到 10/20", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(sure!.card?.reviewing).toBeUndefined();
});

test("一句话纠正: the previous card is withdrawn, the misreading remembered, and later turns go straight to the stronger model", async () => {
  const store = setup();
  worker.mockResolvedValueOnce(replied([dueOn("2026-10-15")]));
  const [, first] = await conversationTurn(TEST_CTX, { text: "截止改到周四", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  worker.mockResolvedValueOnce(replied([dueOn("2026-10-16")], { corrects: true }));
  await conversationTurn(TEST_CTX, { text: "不对，是周五", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(loadConversation(TEST_CTX).messages.find((message) => message.id === first!.id)!.card!.items).toEqual([{ state: "dismissed", message: "已由后一句更正" }]);
  expect(store.preferenceLines(ws, ["all"]).join("\n")).toContain("本人更正：「不对，是周五」");
  worker.mockResolvedValueOnce(replied([]));
  await conversationTurn(TEST_CTX, { text: "好的", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(JSON.parse(String(worker.mock.calls.at(-1)![2]!.body)).corrected).toBe(true);
});

test("字段点改: a field changed on the card is what runs, and the change is remembered as a correction", async () => {
  const store = setup();
  worker.mockResolvedValue(replied([dueOn("2026-10-15")]));
  const [, reply] = await conversationTurn(TEST_CTX, { text: "截止改到周四", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  const decided = await decideCard(TEST_CTX, reply!.id, { edits: { 0: { date: "2026-10-17", notAField: "x" } } }, NOW);
  expect(decided).toMatchObject({ ok: true, message: { card: { items: [{ state: "done" }], actions: [{ args: { date: "2026-10-17" } }] } } });
  expect((store.listWorkOrders(ws).find((order) => order.id === "sim")!.payload as { dueDate?: string }).dueDate).toBe("2026-10-17");
  expect(store.preferenceLines(ws, ["all"]).join("\n")).toContain("date「2026-10-15」改为「2026-10-17」");
});
