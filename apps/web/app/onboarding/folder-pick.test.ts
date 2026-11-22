import { describe, expect, test } from "vitest";
import { FOLDER_UPLOAD_LIMIT, planFolderUpload } from "./folder-pick";

const file = (path: string, size = 1000, modified = 0) => ({ path, size, modified });

describe("planFolderUpload", () => {
  test("readable papers go up; credentials never; private-looking papers are skipped (D15); an AI chat export is read, other JSON is not", () => {
    const plan = planFolderUpload([
      file("课程/ECE555/syllabus.pdf"), file("课程/notes.md"),
      file("课程/api_keys.txt"), file("课程/.env"),
      file("课程/2025 Tax Return.pdf"),
      file("课程/node_modules/pkg/readme.md"), file("课程/photo.jpg"), file("课程/.hidden.md"),
      file("课程/chatgpt/conversations.json"), file("课程/package.json")
    ]);
    expect(plan.upload.sort()).toEqual(["课程/ECE555/syllabus.pdf", "课程/chatgpt/conversations.json", "课程/notes.md"]);
    expect(plan.readable.sort()).toEqual(plan.upload.sort());
    expect(plan.credentials).toBe(2);
    expect(plan.sensitive.map((item) => item.path)).toEqual(["课程/2025 Tax Return.pdf"]);
    expect(plan.skipped).toBe(4);
  });

  test("past the limit the most recently changed files are kept and the rest counted", () => {
    const many = Array.from({ length: FOLDER_UPLOAD_LIMIT + 5 }, (_, index) => file(`f/n${index}.md`, 10, index));
    const plan = planFolderUpload(many);
    expect(plan.upload).toHaveLength(FOLDER_UPLOAD_LIMIT);
    expect(plan.upload[0]).toBe(`f/n${FOLDER_UPLOAD_LIMIT + 4}.md`);
    expect(plan.over).toBe(5);
    expect(plan.readable).toHaveLength(FOLDER_UPLOAD_LIMIT + 5);
  });

  test("a picked folder whose own name looks like a skipped directory is still read", () => {
    expect(planFolderUpload([file("build/plan.md")]).upload).toEqual(["build/plan.md"]);
  });
});
