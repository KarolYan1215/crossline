import { expect, test } from "vitest";
import { CONTEXT_BUDGETS, unverifiedUnits } from "@crossline/core";
import { CrosslineStore, type StoredSourceDocument } from "@crossline/db";
import { analysisMaterialInputs, materialExcerpts, relevantFacts, selectMaterial } from "./material-context";

const WS = "w";
const now = "2026-10-20T00:00:00.000Z";
const doc = (id: string, fileName: string, text: string, projectId?: string): StoredSourceDocument => ({ id, ownerId: "o", workspaceId: WS,
  kind: "text", fileName, mediaType: "text/plain", sha256: id, uri: `file:///${id}`, extractedText: text, extractionStatus: "done", createdAt: now,
  ...(projectId ? { projectId } : {}) });

function board() {
  const store = new CrosslineStore(":memory:");
  for (const [id, name, identityId] of [["ece548", "ECE 548", "research"], ["mos2", "MoS2 训练", "research"], ["bp", "静默语音输入", "startup"]] as const)
    store.saveProject({ id, ownerId: "o", workspaceId: WS, identityId, name, status: "active", summary: "", createdAt: now, updatedAt: now });
  const lectures = Array.from({ length: 40 }, (_, i) => `Lecture ${i + 1}: VLSI timing analysis part ${i + 1}, midterm material.`).join("\n");
  store.saveSourceDocument(doc("plan", "Lecture Plan.docx", lectures, "ece548"));
  store.saveSourceDocument(doc("hw", "ECE 548 HW1.pdf", "Problem 1: compute the timing slack. Problem 2: midterm review of power.", "ece548"));
  store.saveSourceDocument(doc("other", "NeuroSim notes.md", "NeuroSim midterm timing notes for the MoS2 array.", "mos2"));
  store.saveSourceDocument(doc("bp", "商业计划书.docx", "midterm timing 商业计划：语音输入模块。", "bp"));
  return store;
}
const scope = { query: "ECE 548 midterm timing review", core: "ECE 548 midterm", workspaceId: WS, projectId: "ece548", identityId: "research", projectName: "ECE 548" };

test("the task's own files come first, another line's last; the strongest passages in full, the rest by one line", () => {
  const store = board();
  const material = selectMaterial(store, scope);
  const view = material.view();
  expect(view.files.filter((file) => file.own).map((file) => file.name).sort()).toEqual(["ECE 548 HW1.pdf", "Lecture Plan.docx"]);
  const order = material.ranked().map((passage) => passage.heading.split(" · ")[0]);
  expect(order.indexOf("商业计划书.docx")).toBeGreaterThan(order.indexOf("NeuroSim notes.md"));
  expect(material.ranked()[0]!.own).toBe(true);
  expect(view.passages.length).toBeGreaterThan(0);
  expect(view.passages.reduce((sum, passage) => sum + passage.text.length, 0)).toBeLessThanOrEqual(CONTEXT_BUDGETS.topFull);
  expect(view.candidates.every((candidate) => candidate.line.length <= 90)).toBe(true);
  expect(new Set([...view.passages, ...view.candidates].map((passage) => passage.id)).size).toBe(view.passages.length + view.candidates.length);
  // Without lookups: the passages in full, no candidate list.
  const fallback = material.fallback();
  expect(fallback).not.toHaveProperty("candidates");
  expect(JSON.stringify(fallback.passages).length).toBeLessThanOrEqual(CONTEXT_BUDGETS.noTools + 2_000);
  store.close();
});

test("the lookups search within the task, the line or everything, read a passage, and stop at the run's budget", async () => {
  const store = board();
  const material = selectMaterial(store, scope);
  const task = String(await material.tools.call("search_material", { query: "midterm", scope: "task" }));
  expect(task).toContain("Lecture Plan.docx");
  expect(task).not.toContain("NeuroSim");
  expect(String(await material.tools.call("search_material", { query: "NeuroSim", scope: "line" }))).toContain("NeuroSim notes.md");
  expect(String(await material.tools.call("search_material", { query: "语音输入模块", scope: "line" }))).toContain("没有找到");
  const id = String(await material.tools.call("search_material", { query: "NeuroSim", scope: "all" })).split(" ")[0]!;
  const read = String(await material.tools.call("read_chunk", { id }));
  expect(read).toContain("NeuroSim midterm timing notes");
  // What was read through the lookups is checked like what was shown: a unit may quote it under its doc id.
  const docId = read.match(/doc-\d+/)![0];
  const documents = material.documents();
  expect(documents.map((item) => item.name)).toContain("NeuroSim notes.md");
  expect(unverifiedUnits([{ id: "u1", title: "NeuroSim", docId, quote: "NeuroSim midterm timing notes" }], documents)).toEqual([]);
  expect(String(await material.tools.call("read_chunk", { id: "c999999" }))).toContain("没有编号");
  let last = "";
  for (let i = 0; i < 500; i += 1) last = String(await material.tools.call("read_chunk", { id: material.view().passages[0]!.id }));
  expect(last).toContain("已到上限");
  expect(material.stats("tools").toolCalls).toBeGreaterThan(500);
  store.close();
});

test("the analysis gets the passages near the best match plus the names of the other files; excerpts stay inside their scope", () => {
  const store = board();
  const inputs = analysisMaterialInputs(store, WS, "复习 ECE 548 Lecture Plan");
  expect(inputs[0]!.text).toContain("Lecture Plan.docx");
  expect(inputs.at(-1)!.id).toBe("uploaded-other-files");
  expect(analysisMaterialInputs(store, WS, "量子引力").map((input) => input.id)).toEqual(["uploaded-other-files"]);
  const project = materialExcerpts(store, WS, "midterm timing", { projectId: "ece548", identityId: "research", within: "project" });
  expect(new Set(project.map((item) => item.file))).toEqual(new Set(["Lecture Plan.docx", "ECE 548 HW1.pdf"]));
  const line = materialExcerpts(store, WS, "midterm timing", { identityId: "research", within: "line" });
  expect(line.map((item) => item.file)).toContain("NeuroSim notes.md");
  expect(line.map((item) => item.file)).not.toContain("商业计划书.docx");
  expect(JSON.stringify(line).length).toBeLessThanOrEqual(CONTEXT_BUDGETS.excerpts + 500);
  store.close();
});

test("facts: the project's first, then the line's by the task's terms, within the budget", () => {
  const fact = (identityId: string, projectId: string, slot: string, value: string) =>
    ({ ownerId: "o", workspaceId: WS, identityId, projectId, slot, value, status: "confirmed" as const, sourceRef: "", sourceQuote: "", updatedAt: now });
  const facts = [
    fact("research", "", "lab_meeting", "每周三组会"),
    fact("research", "", "timing", "midterm 前要复习 timing"),
    fact("research", "ece548", "grading", "期中 30%"),
    fact("startup", "", "funding", "天使轮"),
    { ...fact("research", "", "guess", "假设：每周 10 小时"), status: "inferred" as const }
  ];
  const lines = relevantFacts(facts as never, { query: "ECE 548 midterm timing", projectId: "ece548", identityId: "research" });
  expect(lines[0]).toContain("grading");
  expect(lines[1]).toContain("timing");
  expect(lines.some((line) => line.includes("funding"))).toBe(false);
  expect(lines.find((line) => line.includes("guess"))).toContain("（假设）");
  expect(relevantFacts(facts as never, { query: "", projectId: "ece548", identityId: "research" }, { budget: 30 })).toHaveLength(1);
});
