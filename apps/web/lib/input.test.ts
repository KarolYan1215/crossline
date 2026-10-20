import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
vi.mock("./capture-followups", () => ({ analyzeNewCapturesInBackground: vi.fn() }));
import { executeAction } from "./actions";
import { identityLines } from "./lines";
import { TEST_CTX } from "./test-support";
import { recentOps, undoOp } from "./undo";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const ws = TEST_CTX.workspaceId;
const op = { workOrderId: "w1", date: "", minutes: 0, stepId: "", text: "", who: "", energy: "" as const };

test("the box's actions write a goal, a milestone draft, a new line and a task note, and every write can be undone", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "w1", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "完成作业 2",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  expect(await executeAction(TEST_CTX, { action: "goal.add", summary: "成为能独立带项目的研究者", args: { lineId: "research", title: "成为能独立带项目的研究者" } })).toMatchObject({ ok: true });
  expect(identityLines(TEST_CTX).find((line) => line.id === "research")?.goals).toContain("成为能独立带项目的研究者");
  expect(await executeAction(TEST_CTX, { action: "milestone.draft", summary: "投出第一篇期刊论文",
    args: { lineId: "research", title: "投出第一篇期刊论文", date: "2026-12-01", target: "期刊审稿中" } })).toMatchObject({ ok: true, href: expect.stringContaining("/milestones?open=") });
  const draft = store.listMilestones(ws).find((item) => item.title === "投出第一篇期刊论文");
  expect(draft?.status).toBe("draft");
  expect(store.listMilestoneAnchors(ws).find((anchor) => anchor.milestoneId === draft?.id)).toMatchObject({ deadline: "2026-12-01", target: "期刊审稿中" });
  expect(await executeAction(TEST_CTX, { action: "line.add", summary: "跑者", args: { label: "跑者", domain: "" } })).toMatchObject({ ok: true });
  expect(identityLines(TEST_CTX).some((line) => line.label === "跑者")).toBe(true);
  expect(await executeAction(TEST_CTX, { action: "task.op", summary: "第三题卡住了", args: { ...op, type: "note", text: "第三题卡住了" } })).toMatchObject({ ok: true });
  expect(store.listEvents(ws, { type: "task.note", entityId: "w1" })).toHaveLength(1);
  expect(store.listCaptures(ws)).toEqual([]);

  // Each write is its own operation in the undo log; taking back the milestone archives the draft, the line disappears again.
  const ops = recentOps(TEST_CTX);
  expect(ops.map((item) => item.label)).toEqual(expect.arrayContaining(["新建里程碑草稿：投出第一篇期刊论文", "新增主线：跑者"]));
  expect(undoOp(TEST_CTX, ops.find((item) => item.label.startsWith("新建里程碑草稿"))!.id)).toMatchObject({ ok: true });
  expect(store.listMilestones(ws).find((item) => item.id === draft?.id)?.status).toBe("archived");
  expect(undoOp(TEST_CTX, ops.find((item) => item.label === "新增主线：跑者")!.id)).toMatchObject({ ok: true });
  expect(identityLines(TEST_CTX).some((line) => line.label === "跑者")).toBe(false);
});

test("a failed action says why in words and records nothing to undo", async () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const before = recentOps(TEST_CTX).length;
  expect(await executeAction(TEST_CTX, { action: "task.op", summary: "开始", args: { ...op, workOrderId: "missing", type: "start" } }))
    .toEqual({ ok: false, message: "任务已不存在" });
  expect(recentOps(TEST_CTX)).toHaveLength(before);
});

test("@ finds tasks and milestones however many files there are, and reads ECE555, HW3 and several words", async () => {
  const { searchMentions, mentionMatches } = await import("./input");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  for (let i = 0; i < 40; i++) store.saveSourceDocument({ id: `d${i}`, ownerId: TEST_CTX.principalId, workspaceId: ws, projectId: "", kind: "text",
    fileName: `Downloads/ECE555-Lecture-${i}.pdf`, mediaType: "application/pdf", sha256: `h${i}`, uri: "", extractedText: "", extractionStatus: "done", createdAt: `2026-10-15T00:00:${String(i).padStart(2, "0")}Z` });
  store.saveWorkOrder({ id: "hw3", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "ece555", milestoneId: "", intent: "完成 ECE 555 作业 3",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { title: "完成 ECE 555 作业 3" } });
  const ids = (query: string, kind?: Parameters<typeof searchMentions>[2]) => searchMentions(TEST_CTX, query, kind).map((item) => `${item.kind}:${item.id}`);
  for (const query of ["ECE", "ece555", "hw3", "ECE 作业", "作业3"]) expect([query, ids(query).includes("task:hw3")]).toEqual([query, true]);
  expect(ids("ECE").filter((id) => id.startsWith("material:")).length).toBe(6);
  expect(ids("ECE", "linkable").some((id) => id.startsWith("material:"))).toBe(false);
  expect(ids("ECE", "material").length).toBe(20);
  expect(mentionMatches("hw 2", "ECE555-F26-Homework2.docx")).toBe(true);
  expect(mentionMatches("hw4", "完成 ECE 555 作业 3")).toBe(false);
});
