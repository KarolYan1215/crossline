import { expect, test } from "vitest";
import { documentProject, leaningProject, plainProject, projectsNamedIn } from "./belonging";

const projects = [{ id: "ece555", name: "ECE 555", identityId: "research" }, { id: "ece548", name: "ECE 548", identityId: "research" },
  { id: "crossline", name: "Crossline", identityId: "startup" }, { id: "xiaohongshu", name: "小红书自媒体", identityId: "media" }];

test("a file is filed by its name first, then by the opening of its text, and only when exactly one project is named", () => {
  expect(documentProject({ fileName: "F26-ECE555-Course Schedule.pdf", extractedText: "" }, projects)).toMatchObject({ project: { id: "ece555" }, basis: "文件名" });
  expect(documentProject({ fileName: "Course Overview.docx", extractedText: "1. Course Name and Number ECE 548: Semiconductor Devices" }, projects))
    .toMatchObject({ project: { id: "ece548" }, basis: "正文开头" });
  expect(documentProject({ fileName: "TENTATIVE_Lecture Plan for Fall 2026.docx", extractedText: "Week-1: 8th Sept L1: Basic Intro: Quantum, Solid State" }, projects)).toBeUndefined();
  expect(documentProject({ fileName: "notes.md", extractedText: "ECE 555 与 ECE 548 合计每周约 15 小时" }, projects)).toBeUndefined();
  expect(projectsNamedIn("Crossline 自用验证", projects).map((item) => item.id)).toEqual(["crossline"]);
});

test("a plain project string is taken at its word, an uncertain one only as a lean", () => {
  expect(plainProject("ECE 555", projects)?.id).toBe("ece555");
  expect(plainProject("ece548", projects)?.id).toBe("ece548");
  expect(plainProject("课程待确认（可能为 ECE 548）", projects)).toBeUndefined();
  expect(leaningProject("课程待确认（可能为 ECE 548）", projects)?.id).toBe("ece548");
  expect(leaningProject("半导体器件课程材料", projects)).toBeUndefined();
});
