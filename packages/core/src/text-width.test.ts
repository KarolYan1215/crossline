import { expect, test } from "vitest";
import { clipWidth, textWidth } from "./text-width";
import { cleanTaskTitle, TASK_TITLE_MAX } from "./task-title";

test("Chinese is measured and cut as before; English gets about 2.5 letters per character of the limit", () => {
  expect(textWidth("完成 ECE 555 作业 2")).toBe(15);
  expect(textWidth("Finish ECE 555 Homework 2")).toBe(10);
  expect(clipWidth("一二三四五六", 4)).toBe("一二三四");
  expect(clipWidth("Draft the interview guide for the MVP launch", 10)).toBe("Draft the interview");
});

test("an English task name of normal length is kept whole, a Chinese one cut at the old limit", () => {
  expect(cleanTaskTitle("Draft the MVP customer interview guide")).toBe("Draft the MVP customer interview guide");
  expect(cleanTaskTitle("一".repeat(30))).toHaveLength(TASK_TITLE_MAX);
});
