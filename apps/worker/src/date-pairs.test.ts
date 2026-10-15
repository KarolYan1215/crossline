import { expect, test } from "vitest";
import { homeworkNumber } from "./date-pairs";

// 「RBT 610 作业 3 截止」 became the task 「完成 RBT 610 作业 610」 (2026-10-15 walkthrough): the course code is not the homework's number.
test("the homework's number is the one after 作业/HW, never the course code's", () => {
  expect(homeworkNumber("RBT 610 作业 3 截止")).toBe("3");
  expect(homeworkNumber("ECE555 HW #4 due")).toBe("4");
  expect(homeworkNumber("作业 2 发布")).toBe("2");
  expect(homeworkNumber("ECE 555 第 5 次作业截止")).toBe("5");
  expect(homeworkNumber("RBT 610 截止")).toBeUndefined();
});
