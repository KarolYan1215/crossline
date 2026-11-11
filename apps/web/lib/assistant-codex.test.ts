import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, currentInstructionsOf, instructionVersionsOf } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { executeAction } from "./actions";
import { contextPack, conversationTurn, decideCard, loadConversation, loadThread } from "./conversation";
import { createThread, listThreads, updateThread } from "./threads";
import { applyInstructions, describeInstructionsChange } from "./instructions";
import { undoOp } from "./undo";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); vi.unstubAllEnvs(); });

const NOW = new Date("2026-11-10T15:00:00.000Z");
const ws = TEST_CTX.workspaceId;
const worker = vi.mocked(requestCodexSupervisor);
const setup = () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  return globalThis.crosslineStore = new CrosslineStore(":memory:");
};

test("a thread the person started: turns go to it, it is named by its first line, the reply keeps the lookups the worker wrote while it ran", async () => {
  const store = setup();
  const thread = createThread(TEST_CTX, "");
  worker.mockImplementation(async (_ctx, _path, init) => {
    const body = JSON.parse(String(init?.body)) as { conversationId: string; replyId: string };
    expect(body.conversationId).toBe(thread.id);
    // The reply exists, empty and running, while the turn runs; the worker appends a step to it (apps/worker/src/concierge.ts).
    const pending = store.getConversationMessage(ws, body.replyId)!;
    expect(pending.payload).toMatchObject({ working: true });
    expect(loadThread(TEST_CTX, thread.id)!.messages.at(-1)).toMatchObject({ working: true });
    store.updateConversationPayload(ws, body.replyId, { ...pending.payload, steps: [{ tool: "find_tasks", args: "{\"query\":\"论文\"}", result: "[]", at: NOW.toISOString() }] });
    return { state: "replied", turn: { reply: "没有找到相关任务。", confidence: "high", actions: [], clarify: { question: "", options: [] } } };
  });
  const [, reply] = await conversationTurn(TEST_CTX, { text: "论文 还有哪些没做", mentions: [], page: { kind: "assistant", entityId: "" }, threadId: thread.id }, NOW);
  expect(reply).toMatchObject({ text: "没有找到相关任务。", steps: [{ tool: "find_tasks" }] });
  expect(reply!.working).toBeUndefined();
  expect(loadThread(TEST_CTX, thread.id)!.title).toBe("论文 还有哪些没做");
  // Today's conversation got nothing; the list shows today first, then the thread.
  expect(loadConversation(TEST_CTX).messages).toEqual([]);
  expect(listThreads(TEST_CTX).map((item) => [item.today, item.id === thread.id])).toEqual([[true, false], [false, true]]);
  expect(updateThread(TEST_CTX, listThreads(TEST_CTX)[0]!.id, { archived: true })).toEqual({ ok: false, code: "THREAD_TODAY_NOT_ARCHIVABLE" });
  expect(updateThread(TEST_CTX, thread.id, { title: "论文进度", archived: true })).toMatchObject({ ok: true, thread: { title: "论文进度", archived: true } });
  expect(listThreads(TEST_CTX, { archived: true }).map((item) => item.id)).toEqual([thread.id]);
  expect(updateThread(TEST_CTX, "thr-nope", { title: "x" })).toEqual({ ok: false, code: "THREAD_NOT_FOUND" });
});

test("「给 Crossline 的话」 through a card: before/after on the card, written only on 确认 as a version, undone by writing the old one again", async () => {
  const store = setup();
  expect(applyInstructions(TEST_CTX, { text: "回答先给结论", by: "person" })).toMatchObject({ ok: true });
  worker.mockResolvedValue({ state: "replied", turn: { reply: "改成这样：", confidence: "high", clarify: { question: "", options: [] },
    actions: [{ action: "instructions.set", summary: "加一条：晚上十点后不提醒学习", args: { text: "回答先给结论\n晚上十点后不提醒学习" } }] } });
  const [, reply] = await conversationTurn(TEST_CTX, { text: "以后晚上十点后别提醒我学习", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(reply!.card!.items[0]).toMatchObject({ state: "pending", diff: [{ kind: "same", text: "回答先给结论" }, { kind: "added", text: "晚上十点后不提醒学习" }] });
  // Nothing is written by the reading.
  expect(currentInstructionsOf(store, ws).version).toBe(1);
  const decided = await decideCard(TEST_CTX, reply!.id, {}, NOW);
  expect(decided).toMatchObject({ ok: true, message: { card: { items: [{ state: "done" }] } } });
  expect(currentInstructionsOf(store, ws)).toEqual({ version: 2, text: "回答先给结论\n晚上十点后不提醒学习" });
  expect(instructionVersionsOf(store, ws).at(-1)!.by).toBe("assistant");
  const opId = (decided as { message: { card: { items: Array<{ opId?: string }> } } }).message.card.items[0]!.opId!;
  expect(undoOp(TEST_CTX, opId)).toMatchObject({ ok: true });
  expect(currentInstructionsOf(store, ws)).toEqual({ version: 3, text: "回答先给结论" });
  expect(instructionVersionsOf(store, ws).at(-1)!.revertOf).toBe(1);
  // A revert to an old version, and the empty text, are versions too; an unchanged text writes nothing.
  expect(applyInstructions(TEST_CTX, { revertTo: 0 })).toMatchObject({ ok: true });
  expect(currentInstructionsOf(store, ws)).toEqual({ version: 4, text: "" });
  expect(applyInstructions(TEST_CTX, { text: "", by: "person" })).toMatchObject({ ok: false, code: "INSTRUCTIONS_UNCHANGED" });
  expect(describeInstructionsChange(TEST_CTX, "a").diff).toEqual([{ kind: "added", text: "a" }]);
});

test("the gaps closed: a design entry paused, a learned preference removed and its 撤销, a line renamed, a setting the box could not reach", async () => {
  const store = setup();
  expect(applyInstructions(TEST_CTX, { text: "x", by: "person" }).ok).toBe(true);
  store.setSetting(ws, "design.personal", JSON.stringify({ entries: [{ kind: "knob", id: "tutorial.leadDays", value: 5, at: NOW.toISOString() }] }));
  store.addPreference({ workspaceId: ws, source: "correction", scope: "all", weight: 1, refId: "conv:x", text: "作业指 ECE 548 的作业" });
  const preference = store.listPreferences(ws)[0]!;
  const pack = await contextPack(TEST_CTX, { kind: "", entityId: "" }, NOW);
  expect(pack.designEntries).toEqual(["knob:tutorial.leadDays"]);
  expect(pack.learned).toEqual([{ id: preference.id, text: "作业指 ECE 548 的作业", lapsed: false }]);
  expect(pack.instructions).toMatchObject({ version: 1, text: "x" });

  expect(await executeAction(TEST_CTX, { action: "design.pause", summary: "暂停教程提前天数", args: { kind: "knob", id: "tutorial.leadDays", change: "pause" } }))
    .toMatchObject({ ok: true, opId: expect.any(String) });
  expect(JSON.parse(store.getSetting(ws, "design.personal")!).entries[0].paused).toBe(true);

  const removed = await executeAction(TEST_CTX, { action: "preference.change", summary: "删掉这条", args: { preferenceId: preference.id, change: "remove" } });
  expect(removed).toMatchObject({ ok: true, opId: expect.any(String) });
  expect(store.listPreferences(ws)).toEqual([]);
  expect(undoOp(TEST_CTX, (removed as { opId: string }).opId)).toMatchObject({ ok: true });
  expect(store.listPreferences(ws).map((item) => item.id)).toEqual([preference.id]);

  const changed = await executeAction(TEST_CTX, { action: "setting.change", summary: "模型更强", args: { key: "model.effort", target: "", value: "higher" } });
  expect(changed).toMatchObject({ ok: true, opId: expect.any(String) });
  expect(store.getSetting(ws, "model.effort")).toBe("higher");
  expect(await executeAction(TEST_CTX, { action: "setting.change", summary: "暂停记录一小时", args: { key: "activity.pauseMinutes", target: "", value: "60" } }))
    .toMatchObject({ ok: true });
  expect(Date.parse(store.getSetting(ws, "localActivity.pausedUntil")!)).toBeGreaterThan(Date.now());
});
