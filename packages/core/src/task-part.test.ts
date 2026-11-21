import { describe, expect, it } from "vitest";
import { partOf, planMerges, wholeTitleOf, type MergeTask } from "./task-merge";

const task = (id: string, title: string, extra: Partial<MergeTask> = {}): MergeTask => ({ id, identityId: "research", projectId: "ece555", milestoneId: "m1",
  title, intent: "", state: "approved", dueDate: "", milestoneDeadline: "", progress: 0, hasStepPlan: false, started: false, dependsOn: [], ...extra });

describe("partOf (W-194)", () => {
  it("takes the named part out of a title", () => {
    expect(wholeTitleOf("ECE 555 作业 3 第 1、2 题")).toBe("ECE 555 作业 3");
    expect(wholeTitleOf("写完作业 3 的前两题")).toBe("写完作业 3");
    expect(wholeTitleOf("HW3 Q1-2")).toBe("HW3");
    expect(wholeTitleOf("ECE 555 作业 3")).toBe("ECE 555 作业 3");
  });
  it("sees the person's 「作业 3 第 1、2 题」 as part of the planned 「完成 ECE 555 作业 3」", () => {
    expect(partOf(task("a", "ECE 555 作业 3 第 1、2 题"), task("b", "完成 ECE 555 作业 3"))).toBe(true);
    expect(partOf(task("a", "写完作业 3 的前两题"), task("b", "作业 3"))).toBe(true);
  });
  it("never joins another homework, another project or the whole to itself", () => {
    expect(partOf(task("a", "作业 3 第 1、2 题"), task("b", "作业 4"))).toBe(false);
    expect(partOf(task("a", "作业 3 第 1、2 题"), task("b", "作业 3", { projectId: "ece548" }))).toBe(false);
    expect(partOf(task("a", "作业 3"), task("b", "作业 3"))).toBe(false);
    expect(partOf(task("a", "作业 3 第 1 题"), task("b", "作业 3 第 2 题"))).toBe(false);
  });
});

describe("planMerges takes a part into its whole (W-194)", () => {
  it("the person's 「作业 3 的前两题」 goes into 「完成 ECE 555 作业 3」, marked as a part", () => {
    const { groups } = planMerges([task("whole", "完成 ECE 555 作业 3", { dueDate: "2026-11-09", hasStepPlan: true }),
      task("part", "作业 3 的前两题", { state: "ready_for_human", dueDate: "2026-11-05" })]);
    expect(groups).toEqual([expect.objectContaining({ kind: "duplicate", part: true, keep: "whole", absorb: ["part"] })]);
  });
  it("作业 3 and 作业 4 never merge, nor does a part already under way", () => {
    expect(planMerges([task("hw3", "完成 ECE 555 作业 3"), task("hw4", "作业 4 的前两题")]).groups).toEqual([]);
    expect(planMerges([task("hw3", "完成 ECE 555 作业 3"), task("part", "作业 3 第 1、2 题", { started: true, state: "active" })]).groups).toEqual([]);
  });
});
