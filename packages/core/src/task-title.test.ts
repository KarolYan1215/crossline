import { expect, test } from "vitest";
import { cleanTaskTitle, taskTitleOf, validateTaskTitles } from "./task-title";

test("a task's name is one short action; a long sentence is cut at its first clause", () => {
  expect(cleanTaskTitle("完成 ECE 555 作业 2。")).toBe("完成 ECE 555 作业 2");
  expect(cleanTaskTitle("选定一项创始人正在处理的真实事项，记录具体使用场景、使用前状态、已有证据")).toBe("选定一项创始人正在处理的真实事项");
  expect(cleanTaskTitle("x".repeat(40))).toHaveLength(24);
  // A task from before names existed shows the first clause of its description; a stored name wins.
  expect(taskTitleOf({ intent: "在周末前整理 ECE 548 前几章的复习提纲，为期中考试做准备。" })).toBe("在周末前整理 ECE 548 前几章的复习提纲");
  expect(taskTitleOf({ intent: "长句", payload: { title: "整理 ECE 548 复习提纲" } })).toBe("整理 ECE 548 复习提纲");
});

test("the titler's answer keeps names for known tasks only", () => {
  expect(validateTaskTitles({ titles: [{ id: "a", title: "完成作业 2。" }, { id: "zz", title: "x" }, { id: "b", title: "  " }] }, ["a", "b"]))
    .toEqual({ titles: [{ id: "a", title: "完成作业 2" }] });
});
