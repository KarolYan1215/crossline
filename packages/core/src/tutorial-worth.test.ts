import { expect, test } from "vitest";
import { TUTORIAL_MIN_MINUTES, taskPreparation, tutorialWorthIt } from "./tutorial-worth";

const step = (minutes: number, executor = "human", role = "solve", schedulable = true) => ({ executor, schedulable, role, status: "planned", estimate: { p50Minutes: minutes } });

test("small tasks, requests for a fact and the assistant's errands get no tutorial; course homework does (W-17)", () => {
  // The walkthrough's 17-minute send.
  expect(tutorialWorthIt({ title: "把门店名单发给陈默", intent: "把整理好的名单发给陈默", p50Minutes: 17 }, [step(10), step(7)])).toBe(false);
  expect(taskPreparation({ title: "向助教确认作业 3 的提交方式", intent: "发邮件问助教", p50Minutes: 60 }).level).toBe("none");
  // The owner's real ECE 555 homework 3: read, solve, check, check, submit.
  expect(tutorialWorthIt({ title: "完成 ECE 555 作业 3", intent: "解 5 道题", p50Minutes: 240, archetypeId: "problem_set" },
    [step(20, "agent", "read"), step(15, "human", "read"), step(45), step(25, "human", "check"), step(30, "human", "check"), step(15, "human", "submit")])).toBe(true);
  // The assistant's steps and unscheduled ones are not the person's work.
  expect(taskPreparation({ title: "整理复习提纲", intent: "整理", p50Minutes: 200, archetypeId: "exam_prep" },
    [step(30, "human", "learn"), step(120, "agent", "gather"), step(60, "human", "practice", false)])).toMatchObject({ level: "steps" });
  expect(taskPreparation({ title: "汇集课程材料", intent: "汇集", p50Minutes: 60, archetypeId: "reading" }, [step(30, "agent", "read"), step(30, "agent", "summarize")]).level).toBe("none");
  // No plan yet: decided once the steps exist.
  expect(taskPreparation({ title: "写第 2 章", intent: "写", p50Minutes: TUTORIAL_MIN_MINUTES }).level).toBe("steps");
});

test("gathering, confirming and deciding work is prepared by its steps only (the owner's account, 2026-10-21)", () => {
  // 「ECE 548 汇集两门课程评分规则」 had a full tutorial built three times.
  expect(taskPreparation({ title: "ECE 548 汇集两门课程评分规则", intent: "汇集", p50Minutes: 85, archetypeId: "research_decision" },
    [step(10, "agent", "gather"), step(10, "human", "compare"), step(20, "agent", "analyze"), step(25, "human", "decide"), step(20, "human", "decide")]))
    .toMatchObject({ level: "steps", reason: expect.stringContaining("整理、确认") });
  expect(tutorialWorthIt({ title: "汇集10月至12月账户记录", intent: "汇集", p50Minutes: 165, archetypeId: "finance" },
    [step(25, "human", "gather"), step(30, "human", "record"), step(30, "human", "record"), step(35, "human", "record"), step(25, "human", "analyze"), step(20, "human", "check")])).toBe(false);
});

test("craft work gets a tutorial only for real method work the person has not done before", () => {
  const calibrate = [step(15, "human", "build"), step(40, "human", "build"), step(40, "human", "build"), step(40, "human", "build"), step(30, "human", "test")];
  expect(taskPreparation({ title: "校准真实任务", intent: "校准", p50Minutes: 165, archetypeId: "build" }, calibrate).level).toBe("tutorial");
  expect(taskPreparation({ title: "校准真实任务", intent: "校准", p50Minutes: 165, archetypeId: "build" }, calibrate, { doneBefore: "搭建试用版" }))
    .toEqual({ level: "steps", reason: "做过同类任务（「搭建试用版」），按当时的做法和步骤即可，不备教程。" });
  // 「列科研笔记提纲」: the person only checks what the assistant drafted.
  expect(tutorialWorthIt({ title: "列科研笔记提纲", intent: "列提纲", p50Minutes: 105, archetypeId: "writing" },
    [step(30, "agent", "gather"), step(30, "human", "check"), step(20, "agent", "draft"), step(25, "human", "check")])).toBe(false);
});
