import { afterEach, beforeEach, expect, test } from "vitest";
import { agentApprovalDecision, approveCategory, CrosslineStore, declineCategory, decideAgentApproval, pendingAgentApprovals, pendingCategoryRequests, setPaused } from "@crossline/db";
import { dispatchCandidates, ledgerAsk, taskFromWorkOrder } from "./agent-dispatch";

let store: CrosslineStore;
let ws: string;
beforeEach(() => { store = new CrosslineStore(":memory:"); ws = store.createPrincipalWithWorkspace("u", "w").workspace.id; });
afterEach(() => store.close());

const estimate = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const order = (id: string, intent: string, ai: string[], over: { state?: string; projectId?: string } = {}) => store.saveWorkOrder({
  id, ownerId: "o", workspaceId: ws, identityId: "research", projectId: over.projectId ?? "p", milestoneId: "", intent, state: over.state ?? "approved", riskTier: "routine", estimate,
  payload: { automationParts: ai.map((text, i) => ({ id: `a${i}`, intent: text })), humanCore: [{ id: "h", intent: "在 Virtuoso 里画图并自己提交" }], materialContract: [] }
});

test("a work order becomes a task: the AI parts as the job, the files given for the project as read-only inputs", () => {
  order("wo-aaaa1111", "熟悉 Cadence", ["整理 6T SRAM 知识点清单并做对照笔记"]);
  store.saveSourceDocument({ id: "d1", ownerId: "o", workspaceId: ws, projectId: "p", kind: "pdf", fileName: "s.pdf", mediaType: "application/pdf", sha256: "x", uri: "file:///C:/Users/karol/Downloads/s.pdf",
    extractedText: "", extractionStatus: "done", createdAt: "2026-10-05T00:00:00.000Z" });
  const result = taskFromWorkOrder(store, ws, "wo-aaaa1111");
  if (!result.ok) throw new Error(result.message);
  expect(result.category).toBe("read_research_organize");
  expect(result.input).toMatchObject({ workOrderId: "wo-aaaa1111", taskId: "agent-aaaa1111-1", title: "熟悉 Cadence", humanPart: "在 Virtuoso 里画图并自己提交", inputs: ["C:\\Users\\karol\\Downloads\\s.pdf"] });
  expect(result.input.what).toContain("6T SRAM 知识点清单");
});

test("only an approved order the person has not started can be handed over, and only if there is something to hand", () => {
  order("wo-active", "x", ["整理笔记"], { state: "active" });
  order("wo-none", "y", []);
  expect(taskFromWorkOrder(store, ws, "wo-active")).toMatchObject({ ok: false, code: "ORDER_NOT_DISPATCHABLE" });
  expect(taskFromWorkOrder(store, ws, "wo-none")).toMatchObject({ ok: false, code: "NOTHING_FOR_ASSISTANT" });
  expect(taskFromWorkOrder(store, ws, "missing")).toMatchObject({ ok: false, code: "ORDER_NOT_FOUND" });
});

test("a kind of work that has not been approved is asked about, not started, and the order waits", () => {
  order("wo-1", "写脚本画图", ["写 Python 脚本清洗数据并画图"]);
  expect(dispatchCandidates(store, ws)).toEqual([]);
  expect(pendingCategoryRequests(store, ws)).toMatchObject([{ category: "data_code_sim", workOrderId: "wo-1" }]);
  approveCategory(store, ws, "data_code_sim");
  expect(dispatchCandidates(store, ws)).toEqual(["wo-1"]);
});

test("a declined kind is left alone, a paused assistant starts nothing, and an order already tried is not tried again", () => {
  order("wo-1", "写脚本画图", ["写 Python 脚本清洗数据并画图"]);
  approveCategory(store, ws, "data_code_sim");
  setPaused(store, ws, true);
  expect(dispatchCandidates(store, ws)).toEqual([]);
  setPaused(store, ws, false);
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "r1", type: "agent.task.requested", entityId: "t1", payload: { title: "x", category: "data_code_sim", workOrderId: "wo-1" } });
  expect(dispatchCandidates(store, ws)).toEqual([]);
  order("wo-2", "写脚本画图", ["写 Python 脚本画图"]);
  declineCategory(store, ws, "data_code_sim");
  expect(dispatchCandidates(store, ws)).toEqual([]);
});

test("wording that points at no kind is never started by itself", () => {
  order("wo-1", "推进", ["推进这件事"]);
  expect(dispatchCandidates(store, ws)).toEqual([]);
  expect(pendingCategoryRequests(store, ws)).toEqual([]);
});

test("a question for the person is answered from the ledger, and declined if nobody answers in time", async () => {
  const request = { kind: "command", subject: "winget install X", rule: "install.global", reason: "系统级安装" };
  let sleeps = 0;
  const ask = ledgerAsk(store, ws, "t1", { timeoutMs: 100, pollMs: 10, sleep: async () => {
    sleeps += 1;
    if (sleeps === 2) decideAgentApproval(store, ws, pendingAgentApprovals(store, ws)[0]!.id, "accepted");
  } });
  expect(await ask(request)).toBe(true);
  const silent = ledgerAsk(store, ws, "t1", { timeoutMs: 30, pollMs: 10, sleep: async () => {} });
  expect(await silent({ ...request, subject: "git push" })).toBe(false);
  expect(pendingAgentApprovals(store, ws)).toEqual([]);
  const expired = store.listEvents(ws, { type: "agent.approval.requested" }).at(-1)!;
  expect(agentApprovalDecision(store, ws, expired.entityId)).toBe("declined");
});

// The real ECE 548 outline came back an empty template: the lecture plan was uploaded during the interview, under no project, and the
// assistant was handed nothing. Unassigned uploads now go with every task, and the line's confirmed facts with them.
test("files uploaded under no project and the line's confirmed facts reach the task; another project's files and guesses do not", () => {
  order("wo-bbbb2222", "整理期中复习提纲", ["整理前几章的概念清单"], { projectId: "ece548" });
  const doc = (id: string, projectId: string | undefined, file: string) => store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws,
    ...(projectId ? { projectId } : {}), kind: "docx", fileName: file, mediaType: "x", sha256: id, uri: `file:///C:/data/${file}`,
    extractedText: "", extractionStatus: "done", createdAt: "2026-10-05T00:00:00.000Z" });
  doc("u1", undefined, "Lecture-Plan.docx");
  doc("o1", "ece555", "ECE555.pdf");
  const fact = (slot: string, status: "confirmed" | "inferred", identityId = "research") => store.upsertProfileFact({ workspaceId: ws, identityId,
    projectId: "ece548", slot, value: `${slot} 的值`, status, sourceRef: "reply-1", sourceQuote: status === "confirmed" ? "原话" : "", updatedAt: "2026-10-05T00:00:00.000Z" });
  fact("target_grade", "confirmed");
  fact("guess", "inferred");
  fact("media_only", "confirmed", "media");
  const result = taskFromWorkOrder(store, ws, "wo-bbbb2222");
  if (!result.ok) throw new Error(result.message);
  expect(result.input.inputs).toHaveLength(1);
  expect(result.input.inputs![0]).toMatch(/Lecture-Plan\.docx$/);
  expect(result.input.what).toContain("target_grade：target_grade 的值");
  expect(result.input.what).not.toContain("guess");
  expect(result.input.what).not.toContain("media_only");
});

test("the assistant's preparation steps are picked up by themselves once the kind is allowed; the person's steps never are", async () => {
  const { CrosslineStore, setCategoryMode } = await import("@crossline/db");
  const { stepDispatchCandidates } = await import("./agent-dispatch");
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m", intent: "期中复习",
    state: "approved", riskTier: "milestone", estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  const base = { deliverable: "公式表.md", doneCriterion: "完成", share: 0.5, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50 }, dependsOn: [], notBefore: "", dueBy: "", tickOutcome: "" };
  store.saveStepPlan("w", "wo", { archetypeId: "exam_prep", quantity: { basis: "讲", amount: 2, unit: "讲" }, rationale: "", steps: [
    { ...base, id: "a", role: "gather", title: "汇编 L1–L7 公式表", schedulable: false, executor: "agent" },
    { ...base, id: "b", role: "practice", title: "限时完成去年期中卷", schedulable: true, executor: "human" }] }, "o", "planned");
  // Not allowed yet: asked about once, nothing starts.
  expect(stepDispatchCandidates(store, "w")).toEqual([]);
  setCategoryMode(store, "w", "read_research_organize", "review");
  const [candidate] = stepDispatchCandidates(store, "w");
  expect(candidate?.orderId).toBe("wo");
  expect(store.getStepPlan("w", "wo")!.steps.find((step) => step.id === candidate!.stepId)?.title).toBe("汇编 L1–L7 公式表");
  store.close();
});
