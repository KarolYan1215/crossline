import { describe, expect, test } from "vitest";
import { staleDateMentions, stepDatesFollowingDue } from "./step-dates";

const step = (status: string, notBefore: string, dueBy: string) => ({ status, notBefore, dueBy });

describe("step dates follow a deadline that moved later (W-155)", () => {
  test("open steps planned for 10/22–10/23 move with a deadline now 10/31; done steps keep theirs", () => {
    const steps = [step("done", "2026-10-20", "2026-10-21"), step("planned", "2026-10-22", "2026-10-22"), step("planned", "2026-10-22", "2026-10-23")];
    expect(stepDatesFollowingDue(steps, "2026-10-31", "2026-10-29")).toEqual([
      step("done", "2026-10-20", "2026-10-21"), step("planned", "2026-10-30", "2026-10-30"), step("planned", "2026-10-30", "2026-10-31")]);
  });

  test("dates still ahead, no deadline, or a deadline already passed leave the plan as it is", () => {
    const ahead = [step("planned", "2026-10-30", "2026-11-01")];
    expect(stepDatesFollowingDue(ahead, "2026-11-05", "2026-10-29")).toEqual(ahead);
    const behind = [step("planned", "2026-10-22", "2026-10-23")];
    expect(stepDatesFollowingDue(behind, undefined, "2026-10-29")).toEqual(behind);
    expect(stepDatesFollowingDue(behind, "2026-10-28", "2026-10-29")).toEqual(behind);
  });

  test("a date that would still be in the past after the move is dropped, and nothing passes the deadline", () => {
    const steps = [step("planned", "2026-10-10", "2026-10-12"), step("planned", "2026-10-20", "2026-10-25")];
    // Moved by 6 days (10/25 → 10/31): 10/10 → 10/16 is still past and dropped; 10/12 → 10/18 too.
    expect(stepDatesFollowingDue(steps, "2026-10-31", "2026-10-29")).toEqual([step("planned", "", ""), step("planned", "", "2026-10-31")]);
  });

  test("a description naming a passed day is flagged while the task is due later", () => {
    expect(staleDateMentions("在10月23日前确认 sleep replay 评审时间", "2026-10-29", "2026-10-31")).toEqual(["2026-10-23"]);
    expect(staleDateMentions("10/22 前交初稿，11/2 定稿", "2026-10-29", "2026-11-05")).toEqual(["2026-10-22"]);
    expect(staleDateMentions("在11月3号前确认", "2026-10-29", "2026-11-05")).toEqual([]);
    expect(staleDateMentions("在10月23日前确认", "2026-10-29", "2026-10-28")).toEqual([]);
    // A fraction or a path is not a date; January seen in late December is next year's.
    expect(staleDateMentions("完成 3/4 的题，1/2/3 节", "2026-10-29", "2026-11-05")).toEqual([]);
    expect(staleDateMentions("1月5日前提交", "2026-12-28", "2027-01-10")).toEqual([]);
  });
});
