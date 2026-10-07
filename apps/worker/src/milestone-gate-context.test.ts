import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import { buildMilestoneGateContext } from "./milestone-gate-runner";

const WORKSPACE = "personal-crossline";
let store: CrosslineStore;
let evidenceRoot: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "crossline-gate-evidence-"));
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 1, status: "approved",
    successCriteria: [{ id: "c", statement: "一条", required: true, measure: { kind: "count", unit: "份", atLeast: 1 } }] });
});
afterEach(() => { store.close(); rmSync(evidenceRoot, { recursive: true, force: true }); });

test("a .txt file evidence claim's own content becomes quotable text, separate from its description label", () => {
  const filePath = path.join(evidenceRoot, "note.txt");
  writeFileSync(filePath, "这是文件里真正的内容，评审应当能引用它");
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "写材料", state: "ready_for_human", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.completed" }, "done:w1", {
    evidence: [{ kind: "file", uri: pathToFileURL(filePath).href, description: "note.txt" }]
  });
  const built = buildMilestoneGateContext(store, WORKSPACE, "w1");
  if ("blocker" in built) throw new Error(`unexpected blocker: ${built.blocker.code}`);
  expect(built.evidenceTexts).toContain("这是文件里真正的内容，评审应当能引用它");
  expect(built.evidenceTexts).toContain("note.txt");
});

// What the assistant hands in for a delegated order is Markdown; it is delivered without anyone starting the order.
test("an assistant's delivered Markdown file is quotable evidence", () => {
  const filePath = path.join(evidenceRoot, "notes.md");
  writeFileSync(filePath, "NeuroSim 2.1 的输入为器件 Ron/Roff 与非线性参数");
  store.saveWorkOrder({
    id: "w2", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "整理输入规范", state: "approved", riskTier: "routine", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
  store.transitionWorkOrder(WORKSPACE, "w2", { type: "agent.delivered", taskId: "t" }, "delivered:w2", {
    evidence: [{ kind: "file", uri: pathToFileURL(filePath).href, description: "助手产出：notes.md" }]
  });
  const built = buildMilestoneGateContext(store, WORKSPACE, "w2");
  if ("blocker" in built) throw new Error(`unexpected blocker: ${built.blocker.code}`);
  expect(built.evidenceTexts).toContain("NeuroSim 2.1 的输入为器件 Ron/Roff 与非线性参数");
});

test("a non-.txt file evidence claim is kept as a submitted record but its binary content is never read", () => {
  const filePath = path.join(evidenceRoot, "photo.png");
  writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "写材料", state: "ready_for_human", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.completed" }, "done:w1", {
    evidence: [{ kind: "file", uri: pathToFileURL(filePath).href, description: "photo.png" }]
  });
  const built = buildMilestoneGateContext(store, WORKSPACE, "w1");
  if ("blocker" in built) throw new Error(`unexpected blocker: ${built.blocker.code}`);
  expect(built.evidenceTexts).toEqual(["photo.png"]);
});

test("checklist answers are flattened into quotable Q/A text using the order's own checklist prompts", () => {
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "写材料", state: "ready_for_human", riskTier: "milestone",
    payload: { evidenceChecklist: [{ id: "q1", prompt: "初稿是否存在？", kind: "checkbox", options: ["是", "否"], required: true }] },
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.completed" }, "done:w1", {
    evidence: [], checklistAnswers: [{ questionId: "q1", answer: "是" }]
  });
  const built = buildMilestoneGateContext(store, WORKSPACE, "w1");
  if ("blocker" in built) throw new Error(`unexpected blocker: ${built.blocker.code}`);
  expect(built.evidenceTexts).toContain("Q: 初稿是否存在？ A: 是");
});

test("no checklist answers and no file evidence leaves the gate context exactly as before this feature", () => {
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research", projectId: "p",
    milestoneId: "m", intent: "写材料", state: "ready_for_human", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" }
  });
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.started" }, "start:w1");
  store.transitionWorkOrder(WORKSPACE, "w1", { type: "human.completed" }, "done:w1", {
    evidence: [{ kind: "record", uri: "local://r", description: "结论记录" }]
  });
  const built = buildMilestoneGateContext(store, WORKSPACE, "w1");
  if ("blocker" in built) throw new Error(`unexpected blocker: ${built.blocker.code}`);
  expect(built.evidenceTexts).toEqual(["结论记录"]);
});
