import { expect, test } from "vitest";
import { cleanTaskTitle, courseCodeOf, sittingStartOn, taskTitleOf, validateTaskTitles, withCourse } from "./task-title";

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

test("a name about a course carries its code, taken only from a project that is not marked uncertain", () => {
  expect(courseCodeOf("ECE 555")).toBe("ECE 555");
  expect(courseCodeOf("ece555")).toBe("ECE 555");
  expect(courseCodeOf("ECE548 Semiconductor Devices")).toBe("ECE 548");
  expect(courseCodeOf("课程待确认（可能为 ECE 548）")).toBeUndefined();
  expect(courseCodeOf("Crossline")).toBeUndefined();
  expect(courseCodeOf("MoS2 FGFET")).toBeUndefined();
  expect(withCourse("课堂期末考试", "ECE 555")).toBe("ECE 555 课堂期末考试");
  expect(withCourse("ECE555 上课", "ECE 555")).toBe("ECE555 上课");
  expect(withCourse("完成 ECE 555 作业 2", "ece555")).toBe("完成 ECE 555 作业 2");
  expect(withCourse("期中考试 1", "课程待确认（可能为 ECE 548）")).toBe("期中考试 1");
});

test("work towards an exam is due when that day's class of the same course starts", () => {
  const blocks = [{ day: "2026-10-27", start: "13:00", title: "ECE 548 课程" }, { day: "2026-10-27", start: "11:00", title: "导师 1V1" },
    { day: "2026-10-28", start: "09:00", title: "ECE 548 课程" }];
  expect(sittingStartOn("ECE 548 期中考试 1 达到 A− 支撑线", "2026-10-27", blocks)).toBe("13:00");
  expect(sittingStartOn("ECE 548 作业 3 提交", "2026-10-27", blocks)).toBeUndefined();
  expect(sittingStartOn("ECE 555 期中考试", "2026-10-27", blocks)).toBeUndefined();
  expect(sittingStartOn("ECE 548 期中考试 1", "2026-10-29", blocks)).toBeUndefined();
});
