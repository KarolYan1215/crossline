import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import * as analysis from "./analysis";
import { fakeRuntime as sharedRuntime, recordedAnswer } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, "crossline:crossline-automation-stripper");

let store: CrosslineStore;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  store.capture({ id: "c", ownerId: "local-owner", workspaceId: "personal-crossline", title: "Decide", context: "" }, "capture:c");
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: "personal-crossline", identityId: "research", projectId: "p", title: "Decide", version: 1, status: "approved" });
});
afterEach(() => store.close());

const proposal = { identityId: "research", projectId: "p", milestoneId: "m", intent: "Decide", family: "deep_work", automationParts: [], humanCore: [{ id: "h", intent: "Decide", energy: "medium", interruptible: true, quote: "Decide", rationale: "Judgment" }], materialContract: [], evidenceContract: [{ kind: "record", description: "Decision", why: "The decision is the deliverable", required: true }], estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }, riskTier: "routine", blockers: [] };

test("duplicate Analyze requests share one durable run and publish only a proposal", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\\repo");
  const [first, duplicate] = await Promise.all([analyze(rpc, "c"), analyze(rpc, "c")]);
  expect(first).toMatchObject({ state: "awaiting_plan_approval", audit: { threadId: "thread-1", turnId: "turn-1" } });
  // The duplicate observes the claimed run rather than starting a second turn.
  expect(duplicate.state).toBe("analyzing");
  await analyze(rpc, "c");
  expect(turns()).toBe(1);
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
  expect(store.listEvents("personal-crossline").map((e) => (e.payload as { to?: string }).to).filter(Boolean)).toEqual(["analyzing", "awaiting_plan_approval"]);
});

test("an answer that is not JSON is sent back on the same thread, and fixed there", async () => {
  const { rpc, turns } = fakeRuntime(["this is not the agreed JSON", JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo");
  const result = await analyze(rpc, "c");
  expect(result).toMatchObject({ state: "awaiting_plan_approval", audit: { threadId: "thread-1", repairs: 1 } });
  expect(turns()).toBe(2);
});

test("a blocked analysis can be retried instead of stranding the capture forever", async () => {
  // Three bad answers: the first try and both repairs. The retry is a new attempt and gets the good one.
  const { rpc, turns } = fakeRuntime(["this is not the agreed JSON", "still not JSON", "nor this", JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\\repo");
  const blocked = await analyze(rpc, "c");
  expect(blocked.state).toBe("blocked");
  expect(blocked.audit.blocker?.code).toMatch(/^ANALYSIS_[A-Z_]+$/);
  expect(store.listWorkOrders("personal-crossline")).toEqual([]);
  const recovered = await analyze(rpc, "c");
  expect(turns()).toBe(4);
  expect(recovered).toMatchObject({ state: "awaiting_plan_approval", attempt: 1 });
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
});

test("approved milestones spanning several identities reach the Skill instead of blocking", async () => {
  // The real seed creates one approved milestone per identity; requiring a single identity made every
  // analysis on a real database end in ANALYSIS_IDENTITY_CONTEXT_REQUIRED without ever sending a turn.
  for (const identityId of ["startup", "media", "investment"]) {
    store.saveMilestone({ id: `${identityId}-m`, ownerId: "local-owner", workspaceId: "personal-crossline",
      identityId, projectId: `${identityId}-default`, title: `${identityId} milestone`, version: 1, status: "approved" });
  }
  const { rpc, turns } = fakeRuntime([JSON.stringify(proposal)]);
  const analyze = analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\\repo");
  const result = await analyze(rpc, "c");
  expect(turns()).toBe(1);
  expect(result).toMatchObject({ state: "awaiting_plan_approval" });
  expect(store.listWorkOrders("personal-crossline")).toHaveLength(1);
});

/**
 * Degenerate model answers, recorded from real runs, driven through the whole path.
 *
 * Until these existed, every fake answer in the repo was clean JSON somebody typed, and each of these
 * four shapes had to be found by hand during an acceptance run. Three are cleaned in place; two are sent back for repair twice and,
 * when the model still returns them, corrected in the smallest way (brackets stripped, a cut-off line marked as cut) and kept with a
 * warning for the reviewer — a quality problem no longer costs the person the whole task (decided 2026-10-07).
 */
const degenerate = [
  { fixture: "analysis-degenerate-scratch-leak", outcome: "kept with a warning", code: "ANALYSIS_CONTRACT_NOT_PROSE", why: "" },
  { fixture: "analysis-degenerate-truncated-description", outcome: "kept with a warning", code: "ANALYSIS_CONTRACT_TRUNCATED", why: "" },
  { fixture: "analysis-degenerate-combining-mark-padding", outcome: "normalised", code: "",
    why: "这是本次清单的主要输入，已由用户提供。" },
  // Alternating zero-width characters, a stray Malayalam letter and a leaked token: real, from the 2026-10-03 structured-output run.
  { fixture: "analysis-degenerate-zero-width-padding", outcome: "normalised", code: "",
    why: "需要提供文件、链接、笔记或其位置，以确定整理对象。" },
  { fixture: "analysis-degenerate-phrase-echo", outcome: "normalised", code: "",
    why: "工作应围绕这些摘录推进，不因缺少原文而停止。" }
] as const;

test.each(degenerate)("a $fixture answer is $outcome all the way through to the ledger", async ({ fixture, outcome, code, why: expectedWhy }) => {
  const { rpc, turns } = fakeRuntime([recordedAnswer(fixture)]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");

  if (outcome === "kept with a warning") {
    // Asked to fix it twice first, then kept in corrected form and handed to the reviewer.
    expect(turns()).toBe(3);
    expect(result.state).toBe("awaiting_plan_approval");
    const kept = store.listWorkOrders("personal-crossline")[0]!.payload as { materialContract: Array<{ description: string }>; evidenceContract: Array<{ description: string }> };
    for (const item of [...kept.materialContract, ...kept.evidenceContract]) {
      expect(item.description).not.toMatch(/[{}[\]]/);
      expect(item.description.length).toBeLessThan(300);
    }
    const warned = store.listEvents("personal-crossline", { type: "validation.warned", entityId: "analysis:c" });
    expect(warned[0]?.payload).toMatchObject({ subject: "analysis", warnings: [{ code }] });
    return;
  }

  expect(result.state).toBe("awaiting_plan_approval");
  const stored = store.listWorkOrders("personal-crossline")[0]!.payload as
    { materialContract: Array<{ why: string }>; evidenceContract: Array<{ description: string }> };
  // What actually landed in the row the approvals page renders — no padding, no echo, sentence intact.
  expect(stored.materialContract[0]!.why).toBe(expectedWhy);
  expect(turns()).toBe(1);
});

test("a rejected answer is sent back with the reason, and the corrected one is accepted", async () => {
  const { rpc, turns, prompts } = fakeRuntime([
    recordedAnswer("analysis-degenerate-truncated-description"),
    recordedAnswer("analysis-clean")
  ]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");

  expect(result).toMatchObject({ state: "awaiting_plan_approval" });
  expect(turns()).toBe(2);
  // The repair turn has to carry what was wrong; without it the model is being asked to guess.
  expect(prompts()[1]).toContain("ANALYSIS_CONTRACT_TRUNCATED");
  expect(prompts()[1]).toContain("契约条目被截断");
  // Recorded so a schema that needs repairing every time reads as a schema problem, not a cost.
  expect(result.audit.repairs).toBe(1);
});

test("a Skill that stops and says why is not coaxed into guessing: its blocker is final, not a rejection to repair", async () => {
  // Real run: for the capture 「整理一下」 the Skill reported a missing input; when that was sent back as a rejection it dropped the
  // blocker and invented the input, twice out of two. A stop is an answer.
  const blocked = { ...proposal, blockers: [{ code: "missing_material", message: "未提供待整理的材料或范围。" }] };
  const { rpc, turns } = fakeRuntime([JSON.stringify(blocked), JSON.stringify(proposal)]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");
  expect(result.state).toBe("blocked");
  expect(result.audit.blocker?.code).toBe("ANALYSIS_POLICY_BLOCKED");
  expect(result.audit.blocker?.message).toContain("未提供待整理的材料或范围");
  expect(turns()).toBe(1);
  expect(store.listWorkOrders("personal-crossline")).toEqual([]);
});

test("the tick analyses a fresh capture on its own, and never one already attempted", async () => {
  // beforeEach seeds capture "c" and an approved milestone "m".
  expect(analysis.capturesAwaitingAutoAnalysis(store, "personal-crossline")).toEqual(["c"]);
  store.capture({ id: "d", ownerId: "local-owner", workspaceId: "personal-crossline", title: "Other", context: "" }, "capture:d");
  expect(analysis.capturesAwaitingAutoAnalysis(store, "personal-crossline", 1)).toEqual(["c"]);

  // Once analysed (and blocked) it waits for the person instead of being retried on a timer.
  const { rpc } = fakeRuntime(["not json", "not json", "not json"]);
  await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");
  expect(analysis.capturesAwaitingAutoAnalysis(store, "personal-crossline")).toEqual(["d"]);

  // No approved milestone is no reason to wait: a new account's first capture is analysed on its first day (Motion's 2–4 weeks
  // before anything useful is what this avoids), filed under its line with no milestone, the way a GTD next action has no project.
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: "personal-crossline", identityId: "research", projectId: "p", title: "Decide", version: 2, status: "archived" });
  expect(analysis.capturesAwaitingAutoAnalysis(store, "personal-crossline")).toEqual(["d"]);
});

test("with no approved milestone at all the capture is still analysed, offered every line, and lands unbound", async () => {
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: "personal-crossline", identityId: "research", projectId: "p", title: "Decide", version: 2, status: "draft" });
  const { rpc, prompts } = fakeRuntime([JSON.stringify({ ...proposal, milestoneId: "" })]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");
  expect(result.state).toBe("awaiting_plan_approval");
  expect(store.listWorkOrders("personal-crossline")[0]).toMatchObject({ identityId: "research", milestoneId: "" });
  for (const line of ["research", "startup", "media", "investment"]) expect(prompts()[0]).toContain(line);
});

test("an identity that is not one of the lines is sent back with the valid ones, not stored (a real capture was filed under 「\」)", async () => {
  const stray = { ...proposal, identityId: "\\", milestoneId: "" };
  const { rpc, turns, prompts } = fakeRuntime([JSON.stringify(stray), JSON.stringify(proposal)]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");
  expect(result).toMatchObject({ state: "awaiting_plan_approval", audit: { repairs: 1 } });
  expect(turns()).toBe(2);
  expect(prompts()[1]).toContain("ANALYSIS_IDENTITY_UNKNOWN");
  expect(prompts()[1]).toContain("research");
  expect(store.listWorkOrders("personal-crossline")[0]).toMatchObject({ identityId: "research" });
});

test("a capture an older version blocked for want of an approved milestone is picked up again by itself and analysed", async () => {
  const ws = "personal-crossline";
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: ws, identityId: "research", projectId: "p", title: "Decide", version: 2, status: "draft" });
  store.transitionWorkOrder(ws, "c", { type: "analysis.proposed", proposalId: "c" }, "analysis:c:0:start", { attempt: 0 });
  store.transitionWorkOrder(ws, "c", { type: "blocked", reason: "ANALYSIS_APPROVED_MILESTONE_REQUIRED" }, "analysis:c:0:finish",
    { audit: { blocker: { code: "ANALYSIS_APPROVED_MILESTONE_REQUIRED", message: "旧版本的阻塞" } } });
  expect(analysis.capturesAwaitingAutoAnalysis(store, ws)).toEqual(["c"]);
  const { rpc } = fakeRuntime([JSON.stringify({ ...proposal, milestoneId: "" })]);
  expect((await analysis.createCaptureAnalyzer(store, ws, "C:\\repo")(rpc, "c")).state).toBe("awaiting_plan_approval");
});

test("files the person already uploaded reach the analysis as supplied material, so it does not ask for them again", () => {
  const ws = "personal-crossline";
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId: ws, kind: "pdf", fileName: "ECE 548 syllabus.pdf", mediaType: "application/pdf", sha256: "1", uri: "file:///1",
    extractedText: "Midterm 1  Oct 27\nChapters 1-4", extractionStatus: "done", createdAt: "2026-10-05T00:00:00.000Z" });
  store.saveSourceDocument({ id: "d2", ownerId: "o", workspaceId: ws, kind: "pdf", fileName: "scan.pdf", mediaType: "application/pdf", sha256: "2", uri: "file:///2",
    extractedText: "", extractionStatus: "failed", createdAt: "2026-10-05T00:00:00.000Z" });
  store.saveSourceDocument({ id: "d3", ownerId: "o", workspaceId: ws, kind: "text", fileName: "recipes.txt", mediaType: "text/plain", sha256: "3", uri: "file:///3",
    extractedText: "番茄炒蛋：先炒蛋再炒番茄。", extractionStatus: "done", createdAt: "2026-10-05T00:00:00.000Z" });
  const inputs = analysis.uploadedMaterialInputs(store, ws, "复习 ECE 548 midterm 前几章");
  // The passage that matches the capture, then one line naming the other readable file; the unreadable scan is not offered.
  expect(inputs.map((input) => input.id)).toEqual(["uploaded-d1-1", "uploaded-other-files"]);
  expect(inputs[0]!.text).toContain("ECE 548 syllabus.pdf");
  expect(inputs[0]!.text).toContain("Midterm 1 Oct 27 Chapters 1-4");
  expect(inputs[0]!.text).toContain("不必再向用户要");
  expect(inputs[1]!.text).toContain("recipes.txt");
  expect(inputs[1]!.text).not.toContain("番茄");
});

// 「10月8号左右师兄会给我数据…10月21号前交」: the waiting item, the release date and the due date land where the
// scheduler and the Today card read them.
test("a promoted order's own dates become a release date, a due date and a waiting item", async () => {
  const { recordWaitingAndDates } = await import("./analysis");
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "", intent: "跑真实数据仿真",
    state: "awaiting_plan_approval", riskTier: "milestone", estimate: { p25Minutes: 1, p50Minutes: 2, p85Minutes: 3, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { dates: [{ kind: "release", date: "2026-10-08", quote: "10月8号左右", approximate: true }, { kind: "due", date: "2026-10-21", quote: "10月21号前", approximate: false }],
      waitingOn: { who: "师兄", what: "西湖MoS2的真实测量数据", expectedDate: "2026-10-08", quote: "10月8号左右师兄会给我" } } });
  recordWaitingAndDates(store, "w", "wo");
  expect(store.listWorkOrders("w")[0]!.payload).toMatchObject({ notBefore: "2026-10-08", dueDate: "2026-10-21" });
  expect(store.listWaitingItems("w")).toMatchObject([{ id: "wait-wo", who: "师兄", expectedAt: "2026-10-08", approximate: true, blocks: ["wo"], state: "open" }]);
  store.close();
});

// The owner's direction of 2026-10-15: completion is the model's judgement, and the board's open tasks are read before writing one.
test("the analysis sees the open tasks, stores its completion judgement, and a capture that adds to an open task is folded into it", async () => {
  store.saveWorkOrder({ id: "open", ownerId: "local-owner", workspaceId: "personal-crossline", identityId: "research", projectId: "p", milestoneId: "m",
    intent: "Hult Prize 第一轮", state: "approved", riskTier: "routine", estimate: proposal.estimate as never, payload: { title: "Hult Prize 第一轮" } });
  const completion = { mode: "needs_assessment", reason: "result_pending", why: "第一轮由评委评审", question: "", askAfterHours: 72 };
  const { rpc, prompts } = fakeRuntime([JSON.stringify({ ...proposal, title: "补 Hult Prize 第一轮材料", completion, extendsTaskId: "open" })]);
  const result = await analysis.createCaptureAnalyzer(store, "personal-crossline", "C:\repo")(rpc, "c");
  expect(result.state).toBe("archived");
  expect((store.getWorkOrder("personal-crossline", "c")!.payload as { completion?: unknown }).completion).toMatchObject({ reason: "result_pending", askAfterHours: 72 });
  expect(store.listEvents("personal-crossline", { type: "task.duplicate_prevented", entityId: "open" })[0]?.payload).toMatchObject({ kind: "extends" });
  expect(prompts().join(" ")).toContain("existingTasks");
});
