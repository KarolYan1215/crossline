import { expect, test } from "vitest";
import { relevantDocuments } from "./relevance";

test("a task gets the files filed under its project, and unfiled ones that name the project", () => {
  const docs = [
    { fileName: "F26-ECE555-Syllabus.pdf", extractedText: "" },
    { fileName: "notes.docx", extractedText: "ECE 555 Lecture Plan for Fall 2026" },
    { fileName: "MoS2-measurements.pdf", extractedText: "单晶 MoS2 忆阻器" },
    { fileName: "hw.pdf", projectId: "ece555" },
    { fileName: "other.pdf", projectId: "mos2" }
  ];
  expect(relevantDocuments(docs, { projectId: "ece555", projectName: "ECE 555" }).map((doc) => doc.fileName))
    .toEqual(["F26-ECE555-Syllabus.pdf", "notes.docx", "hw.pdf"]);
  // Without a project name to match, only the files filed under it.
  expect(relevantDocuments(docs, { projectId: "mos2" }).map((doc) => doc.fileName)).toEqual(["other.pdf"]);
});
