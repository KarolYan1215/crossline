import { expect, test } from "vitest";
import { TUTORIAL_MIN_MINUTES, tutorialWorthIt } from "./tutorial-worth";

const step = (minutes: number, executor = "human", schedulable = true) => ({ executor, schedulable, status: "planned", estimate: { p50Minutes: minutes } });

test("small tasks and requests for a fact get no tutorial; real work does (W-17)", () => {
  // The walkthrough's 17-minute send.
  expect(tutorialWorthIt({ title: "把门店名单发给陈默", intent: "把整理好的名单发给陈默", p50Minutes: 17 }, [step(10), step(7)])).toBe(false);
  expect(tutorialWorthIt({ title: "向助教确认作业 3 的提交方式", intent: "发邮件问助教", p50Minutes: 60 })).toBe(false);
  expect(tutorialWorthIt({ title: "完成 ECE 555 作业 3", intent: "解 5 道题", p50Minutes: 240 }, [step(90), step(90), step(30)])).toBe(true);
  // The assistant's steps and unscheduled ones are not the person's work.
  expect(tutorialWorthIt({ title: "整理复习提纲", intent: "整理", p50Minutes: 200 }, [step(30), step(120, "agent"), step(60, "human", false)])).toBe(false);
  // No plan yet: the task's own estimate decides.
  expect(tutorialWorthIt({ title: "写第 2 章", intent: "写", p50Minutes: TUTORIAL_MIN_MINUTES })).toBe(true);
});
