import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
vi.mock("./capture-followups", () => ({ analyzeNewCapturesInBackground: vi.fn() }));
import { requestCodexSupervisor } from "./codex-runtime";
import { executeAction } from "./actions";
import { conversationTurn } from "./conversation";
import { TEST_CTX } from "./test-support";

const ws = TEST_CTX.workspaceId;
const owner = TEST_CTX.principalId;
const NOW = "2026-10-10T15:00:00.000Z";
const estimate = { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
let dir: string;
let store: CrosslineStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-box-files-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW);
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece548", ownerId: owner, workspaceId: ws, identityId: "research", name: "ECE 548", status: "active", summary: "", createdAt: NOW, updatedAt: NOW });
  store.saveWorkOrder({ id: "hw2", ownerId: owner, workspaceId: ws, identityId: "research", projectId: "ece548", milestoneId: "", intent: "完成 ECE 548 作业 2",
    state: "approved", riskTier: "routine", estimate, payload: {} });
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(dir, { recursive: true, force: true }); });

function doc(id: string, fileName: string, kind: "pdf" | "text", text: string, projectId?: string) {
  const file = path.join(dir, `${id}.${kind === "pdf" ? "pdf" : "txt"}`);
  writeFileSync(file, kind === "pdf" ? "%PDF-1.4" : text);
  return store.saveSourceDocument({ id, ownerId: owner, workspaceId: ws, ...(projectId ? { projectId } : {}), kind, fileName, mediaType: kind === "pdf" ? "application/pdf" : "text/plain",
    sha256: id, uri: pathToFileURL(file).href, extractedText: text, extractionStatus: "done", createdAt: NOW });
}

test("a file dropped with a line is named in the message and described in the snapshot the turn reads", async () => {
  doc("d1", "ECE_548_Homework-2.pdf", "pdf", "ECE 548 Homework 2. Due Oct 16. Problem 1: pn junction ...");
  vi.mocked(requestCodexSupervisor).mockResolvedValue({ state: "replied", turn: { reply: "", confidence: "high", actions: [], clarify: { question: "", options: [] }, corrects: false } });
  const [person] = await conversationTurn(TEST_CTX, { text: "", mentions: [], page: { kind: "today", entityId: "" }, files: ["d1", "nope"] });
  expect(person!.text).toContain("《ECE_548_Homework-2.pdf》");
  const body = JSON.parse(String(vi.mocked(requestCodexSupervisor).mock.calls[0]![2]!.body)) as { snapshot: string; text: string };
  expect(body.snapshot).toContain("d1 | ECE_548_Homework-2.pdf | pdf");
  expect(body.snapshot).toContain("Due Oct 16");
  expect(body.text).toBe("（只附了文件）");
});

test("a homework file becomes the task's material: filed under its project, noted on the task, and the steps re-planned", async () => {
  doc("d1", "ECE_548_Homework-2.pdf", "pdf", "ECE 548 Homework 2");
  store.saveStepPlan(ws, "hw2", { archetypeId: "problem_set", quantity: { basis: "题", amount: 3, unit: "题" }, rationale: "", steps: [] }, owner, "planned");
  expect(await executeAction(TEST_CTX, { action: "material.attach", summary: "作业 2 题目", args: { documentId: "d1", workOrderId: "hw2" } })).toMatchObject({ ok: true });
  expect(store.listSourceDocuments(ws)[0]!.projectId).toBe("ece548");
  expect(store.listEvents(ws, { type: "source.project_assigned" })).toHaveLength(1);
  expect(store.listEvents(ws, { type: "task.note", entityId: "hw2" }).map((event) => (event.payload as { text: string }).text)).toEqual(["添加材料《ECE_548_Homework-2.pdf》"]);
  expect(store.listEvents(ws, { type: "task.steps_replan_requested", entityId: "hw2" })).toHaveLength(1);
});

test("finished work handed in starts the task if needed, completes it, and puts a PDF's text beside it so the gate can quote it", async () => {
  doc("d2", "HW2-solution.pdf", "pdf", "Problem 1: W = 0.42 um");
  const result = await executeAction(TEST_CTX, { action: "evidence.submit", summary: "提交作业 2", args: { workOrderId: "hw2", documentIds: ["d2"], note: "三题都做了" } });
  expect(result).toMatchObject({ ok: true });
  // Handing in is accepting (2026-10-15); the files are kept as its evidence all the same.
  expect(store.listWorkOrders(ws).find((order) => order.id === "hw2")!.state).toBe("accepted");
  const claims = store.listEvidenceClaims(ws).filter((claim) => claim.workOrderId === "hw2");
  expect(claims.map((claim) => claim.kind).sort()).toEqual(["file", "file", "record"]);
  const text = claims.find((claim) => claim.uri.endsWith(".extracted.txt"))!;
  expect(readFileSync(new URL(text.uri), "utf8")).toBe("Problem 1: W = 0.42 um");
});

test("a syllabus goes to the interview for its dates; without an interview it says where to start one", async () => {
  doc("d3", "F26-ECE548-Schedule.pdf", "pdf", "Oct 27 Midterm 1");
  expect(await executeAction(TEST_CTX, { action: "dates.read", summary: "读日期", args: { documentId: "d3", projectId: "ece548" } }))
    .toEqual({ ok: false, message: "还没有访谈；先在画像页开始访谈，日期由访谈读取" });
  // The file was filed under its course before the interview was found missing; filing stands on its own.
  expect(store.listSourceDocuments(ws).find((item) => item.id === "d3")!.projectId).toBe("ece548");
});

test("the two carried over from the old assistant: a file written for a task is kept as its material, a template is added", async () => {
  const saved = await executeAction(TEST_CTX, { action: "material.save", summary: "推导脚本", args: { workOrderId: "hw2", fileName: "depletion.py", content: "print(0.42)\n" } });
  expect(saved).toMatchObject({ ok: true });
  const file = store.listSourceDocuments(ws).find((item) => item.fileName === "depletion.py")!;
  expect(file).toMatchObject({ projectId: "ece548", extractionStatus: "done", extractedText: "print(0.42)\n" });
  const template = await executeAction(TEST_CTX, { action: "template.add", summary: "期中考试模板", args: { lineId: "research", kind: "threshold", titleHint: "期中考试达到分数线",
    criteria: [{ statement: "期中成绩达到分数线", required: true, evidenceOf: "outcome", measure: "threshold", unit: "分", number: 85, comparator: "gte", mustExist: "", rubric: "", failsWhen: "" }] } });
  expect(template).toMatchObject({ ok: true });
  expect(store.listMilestoneTemplates(ws).some((item) => item.titleHint === "期中考试达到分数线")).toBe(true);
  expect(await executeAction(TEST_CTX, { action: "template.add", summary: "缺数值", args: { lineId: "research", kind: "threshold", titleHint: "不完整",
    criteria: [{ statement: "x", required: true, evidenceOf: "outcome", measure: "threshold", unit: "", number: 0, comparator: "", mustExist: "", rubric: "", failsWhen: "" }] } }))
    .toMatchObject({ ok: false });
});
