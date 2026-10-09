import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { fileSourceDocuments } from "./source-filing";

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
