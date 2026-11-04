import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore, NOTES_SESSION, pendingExtractDocs, type PersonNote } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { executeAction } from "./actions";
import { conversationTurn } from "./conversation";
import { reportProgress } from "./steps";
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
const notes = (store: CrosslineStore) => store.listOnboardingMessages(ws, NOTES_SESSION).map((message) => message.content as PersonNote);

test("a line in the box that became no action is kept for the extraction; one with actions is not, nor a bare question", async () => {
  const store = setup();
  worker.mockResolvedValue({ state: "replied", turn: { reply: "记下了。", confidence: "high", actions: [], clarify: { question: "", options: [] } } });
  await conversationTurn(TEST_CTX, { text: "每周二上午十点和导师开组会", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  await conversationTurn(TEST_CTX, { text: "明天要做什么？", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  worker.mockResolvedValue({ state: "replied", turn: { reply: "", confidence: "high", clarify: { question: "", options: [] },
    actions: [{ action: "task.op", summary: "截止改为 10/16", args: { workOrderId: "sim", type: "due", date: "2026-10-16", minutes: 0, stepId: "", text: "", who: "", energy: "" } }] } });
  await conversationTurn(TEST_CTX, { text: "数据处理改到 16 号交", mentions: [], page: { kind: "today", entityId: "" } }, NOW);
  expect(notes(store).map((note) => note.text)).toEqual(["每周二上午十点和导师开组会"]);
  expect(notes(store)[0]).toMatchObject({ source: { kind: "conversation" }, about: "在输入框里说的" });
  // The interview the app shows is still none: the notes are not it.
  expect(store.getLatestOnboardingSession(ws)).toBeUndefined();
});

test("an ask answered from the box keeps the person's words; where no option takes them they are read for facts", async () => {
  const store = setup();
  expect(await executeAction(TEST_CTX, { action: "ask.answer", summary: "不等了", args: { askId: "wait:wait-sim-0", optionId: "cancelled", fields: [],
    note: "师兄下周三才回实验室，到时再当面要" } })).toMatchObject({ ok: true });
  expect(store.listEvents(ws, { type: "ask.answered" }).at(-1)!.payload).toMatchObject({ note: "师兄下周三才回实验室，到时再当面要" });
  expect(notes(store)).toEqual([expect.objectContaining({ text: "师兄下周三才回实验室，到时再当面要", about: expect.stringContaining("西湖 MoS2 真实测量数据"),
    source: expect.objectContaining({ kind: "ask" }) })]);
});

test("「记一笔」 and a progress report are read for facts as well", () => {
  const store = setup();
  void executeAction(TEST_CTX, { action: "note.add", summary: "记一笔", args: { text: "ECE 555 期中改到 11 月 12 日" } });
  expect(reportProgress(TEST_CTX, "sim", "前两组数据处理完，师兄说第三组周五给")).toMatchObject({ ok: true });
  expect(notes(store).map((note) => [note.source.kind, note.text])).toEqual([["note", "ECE 555 期中改到 11 月 12 日"], ["progress", "前两组数据处理完，师兄说第三组周五给"]]);
  expect(notes(store)[1]!.about).toContain("处理西湖");
});

test("a 「告诉系统」 the worker does not take is kept for the extraction; a file to read dates from waits for it", async () => {
  const store = setup();
  store.saveOnboardingSession({ id: "main", ownerId: TEST_CTX.principalId, workspaceId: ws, state: "complete", coverage: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  store.saveSourceDocument({ id: "d1", ownerId: TEST_CTX.principalId, workspaceId: ws, kind: "text", fileName: "syllabus.txt", mediaType: "text/plain", sha256: "x",
    uri: "file:///x", extractedText: "Midterm: 27th Oct.", extractionStatus: "done", createdAt: NOW.toISOString() });
  worker.mockRejectedValue(new Error("worker down"));
  expect(await executeAction(TEST_CTX, { action: "profile.tell", summary: "告诉系统", args: { text: "我周末一般不工作，只看论文", lineId: "" } })).toMatchObject({ ok: true });
  expect(await executeAction(TEST_CTX, { action: "dates.read", summary: "读日期", args: { documentId: "d1", projectId: "" } })).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(notes(store).map((note) => note.text)).toEqual(["我周末一般不工作，只看论文"]));
  await vi.waitFor(() => expect(pendingExtractDocs(store, ws)).toEqual(["d1"]));
});
