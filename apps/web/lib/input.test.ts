import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { captureItem, type RoutedItem } from "@crossline/core";
vi.mock("server-only", () => ({}));
const routed: { items: RoutedItem[] } = { items: [] };
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ routed: true, ...routed })), CodexSupervisorRequestError: class extends Error {} }));
vi.mock("./capture-followups", () => ({ analyzeNewCapturesInBackground: vi.fn() }));
import { routeInput } from "./input";
import { identityLines } from "./lines";
import { TEST_CTX } from "./test-support";
import { recentOps, undoOp } from "./undo";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

const ws = TEST_CTX.workspaceId;
const blank = { ...captureItem(""), title: "" };

test("the input box writes a goal, a milestone draft, a new line and a record, hands a question on, and every write can be undone", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "w1", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: "完成作业 2",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  routed.items = [
    { ...blank, kind: "goal", title: "成为能独立带项目的研究者", lineId: "research" },
    { ...blank, kind: "milestone", title: "投出第一篇期刊论文", lineId: "research", date: "2026-12-01", context: "期刊审稿中" },
    { ...blank, kind: "line", title: "跑者" },
    { ...blank, kind: "record", title: "第三题卡住了", workOrderId: "w1" },
    { ...blank, kind: "question", title: "这周还有多少空闲？" }
  ];
  const outcome = await routeInput(TEST_CTX, { text: "…", batch: true, mentions: [] });
  expect(outcome.goals).toEqual([{ lineId: "research", line: expect.any(String), title: "成为能独立带项目的研究者" }]);
  expect(identityLines(TEST_CTX).find((line) => line.id === "research")?.goals).toContain("成为能独立带项目的研究者");
  const draft = store.listMilestones(ws).find((item) => item.title === "投出第一篇期刊论文");
  expect(draft?.status).toBe("draft");
  expect(store.listMilestoneAnchors(ws).find((anchor) => anchor.milestoneId === draft?.id)).toMatchObject({ deadline: "2026-12-01", target: "期刊审稿中" });
  expect(outcome.lines).toEqual([{ id: expect.any(String), label: "跑者" }]);
  expect(identityLines(TEST_CTX).some((line) => line.label === "跑者")).toBe(true);
  expect(store.listEvents(ws, { type: "task.note", entityId: "w1" })).toHaveLength(1);
  expect(outcome.questions).toEqual(["这周还有多少空闲？"]);
  expect(outcome.captured).toEqual([]);

  // Each write is its own operation in the undo log; taking back the milestone archives the draft, the line disappears again.
  const ops = recentOps(TEST_CTX);
  expect(ops.map((op) => op.label)).toEqual(expect.arrayContaining(["新建里程碑草稿：投出第一篇期刊论文", "新增主线：跑者"]));
  expect(undoOp(TEST_CTX, ops.find((op) => op.label.startsWith("新建里程碑草稿"))!.id)).toMatchObject({ ok: true });
  expect(store.listMilestones(ws).find((item) => item.id === draft?.id)?.status).toBe("archived");
  expect(undoOp(TEST_CTX, ops.find((op) => op.label === "新增主线：跑者")!.id)).toMatchObject({ ok: true });
  expect(identityLines(TEST_CTX).some((line) => line.label === "跑者")).toBe(false);
});
