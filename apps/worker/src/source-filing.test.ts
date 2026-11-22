import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createFileProjectReader, fileSourceDocuments } from "./source-filing";
import { FOLDER_CLASSIFIER } from "./folder-classifier";
import { scriptedRuntime } from "./testing/fake-runtime";

test("an upload is filed under the one project its name or opening names; one that names none or several stays unfiled", () => {
  const store = new CrosslineStore(":memory:");
  const ws = "w";
  for (const [id, name] of [["ece555", "ECE 555"], ["ece548", "ECE 548"]]) store.saveProject({ id: id!, ownerId: "o", workspaceId: ws, identityId: "research", name: name!, summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  const doc = (id: string, fileName: string, text: string) => store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws, kind: "text", fileName, mediaType: "text/plain",
    sha256: id, uri: `file://${id}`, extractedText: text, extractionStatus: "done", createdAt: "2026-10-01T00:00:00Z" });
  doc("a", "F26-ECE555-Syllabus.pdf", "Digital Circuits");
  doc("b", "Course Overview.docx", "1. Course Name and Number ECE 548: Semiconductor Devices");
  doc("c", "TENTATIVE_Lecture Plan.docx", "Week-1: Quantum, Solid State");
  doc("d", "profile.md", "ECE 555 与 ECE 548 合计每周约 15 小时");
  expect(fileSourceDocuments(store, ws)).toEqual([{ id: "a", projectId: "ece555" }, { id: "b", projectId: "ece548" }]);
  expect(store.listSourceDocuments(ws).map((item) => [item.id, item.projectId ?? null])).toEqual([["a", "ece555"], ["b", "ece548"], ["c", null], ["d", null]]);
  expect(store.listEvents(ws, { type: "source.project_inferred" }).map((event) => (event.payload as { basis: string }).basis)).toEqual(["文件名", "正文开头"]);
  // Run again: nothing new.
  expect(fileSourceDocuments(store, ws)).toEqual([]);
  store.close();
});

// 2026-11-22: what code cannot file goes to the folder classifier once per file; a project it does not know counts as none.
test("files code left unfiled are read by the model once; only a known project it names files them", async () => {
  const store = new CrosslineStore(":memory:");
  const ws = "w";
  for (const [id, name] of [["p1", "RBT 610 Robot Perception"], ["p2", "RBT 610 期末项目"]]) store.saveProject({ id: id!, ownerId: "o", workspaceId: ws, identityId: "research", name: name!, summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  const doc = (id: string, fileName: string) => store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws, kind: "text", fileName, mediaType: "text/plain",
    sha256: id, uri: `file://${id}`, extractedText: "", extractionStatus: "done", createdAt: "2026-10-01T00:00:00Z" });
  doc("a", "RBT610-Fall2026-Syllabus.pdf");
  doc("b", "weekly plan.md");
  doc("c", "receipt.pdf");
  expect(fileSourceDocuments(store, ws)).toEqual([]);
  const runtime = scriptedRuntime([FOLDER_CLASSIFIER], () => JSON.stringify({ files: [
    { id: "a", projectId: "p1", why: "课程大纲属于课程本身" }, { id: "b", projectId: "", why: "涉及多个项目" }, { id: "c", projectId: "ghost", why: "x" }] }));
  const read = createFileProjectReader(store, ws, "C:\\repo", () => runtime.rpc);
  expect(await read()).toEqual({ filed: 1 });
  expect(store.listSourceDocuments(ws).map((item) => [item.id, item.projectId ?? null])).toEqual([["a", "p1"], ["b", null], ["c", null]]);
  expect(store.listEvents(ws, { type: "source.project_inferred" }).map((event) => event.payload)).toEqual([expect.objectContaining({ projectId: "p1", basis: "模型判断" })]);
  // Each file is asked once.
  expect(await read()).toEqual({ filed: 0 });
  store.close();
});
