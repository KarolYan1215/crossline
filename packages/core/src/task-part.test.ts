import { describe, expect, it } from "vitest";
import { partOf, wholeTitleOf, type MergeTask } from "./task-merge";

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
