import "@crossline/i18n/catalog/worker";
import { expect, test } from "vitest";
import { comparePair, duplicateOf, normalizeTaskTitle, planMerges, type MergeTask } from "./task-merge";

const task = (id: string, title: string, intent = "", extra: Partial<MergeTask> = {}): MergeTask => ({ id, identityId: "research", projectId: "ece548",
  milestoneId: "m1", title, intent, state: "approved", dueDate: "", milestoneDeadline: "", progress: 0, hasStepPlan: false, started: false, dependsOn: [], ...extra });

// Code only draws candidates (2026-11-22): synonyms, course codes and numbers are the reviewer's call.
test("only titles identical as compared are settled by code; spaces, punctuation, case and filler words do not count", () => {
  expect(normalizeTaskTitle("Gather the ECE 548 review notes")).toBe(normalizeTaskTitle("gather ECE548 review notes."));
  expect(comparePair(task("a", "整理 ECE 548 复习材料"), task("b", "整理ECE548复习材料")).verdict).toBe("same");
  expect(normalizeTaskTitle("汇集 ECE 548 复习资料")).not.toBe(normalizeTaskTitle("整理 ECE 548 复习材料"));
});

test("differently worded titles that share enough go to the reviewer, in any language; unrelated ones do not", () => {
  expect(comparePair(task("a", "汇集 ECE 548 复习材料", "期中复习"), task("b", "整理 ECE 548 复习材料", "期中复习")).verdict).toBe("unsure");
  expect(comparePair(task("a", "Gather the review notes", "midterm review"), task("b", "Compile review materials", "midterm review")).verdict).toBe("unsure");
  expect(comparePair(task("a", "Homework 2"), task("b", "Homework 3")).verdict).toBe("unsure");
  expect(comparePair(task("a", "整理 ECE 548 复习材料", "期中"), task("b", "写论文方法部分", "方法")).verdict).toBe("different");
  // The reviewer's yes merges a candidate; without it nothing merges.
  const pair = [task("a", "汇集 ECE 548 复习材料", "期中复习"), task("b", "整理 ECE 548 复习材料", "期中复习")];
  expect(planMerges(pair).groups).toEqual([]);
  expect(planMerges(pair).unsure).toHaveLength(1);
  expect(planMerges(pair, new Set(["a|b"])).groups).toMatchObject([{ kind: "duplicate", keep: "a", absorb: ["b"] }]);
  // At creation only an identical title is stopped; a candidate is created and left to the daily merge.
  expect(duplicateOf(task("n", "整理 ECE 548 复习材料"), [task("b", "整理 ECE 548 复习材料")])?.keep.id).toBe("b");
  expect(duplicateOf(task("n", "汇集 ECE 548 复习材料"), [task("b", "整理 ECE 548 复习材料")])).toBeUndefined();
});

test("only the line, project and side keep tasks apart; far due days and milestones go to the reviewer, never ruled out (2026-11-25)", () => {
  expect(comparePair(task("a", "整理复习材料"), task("b", "整理复习材料", "", { owner: "assistant" })).verdict).toBe("different");
  expect(comparePair(task("a", "整理复习材料"), task("b", "整理复习材料", "", { projectId: "ece555" })).verdict).toBe("different");
  const dueApart = [task("a", "整理复习材料", "", { dueDate: "2026-10-01" }), task("b", "整理复习材料", "", { dueDate: "2026-10-20" })] as const;
  expect(comparePair(...dueApart).verdict).toBe("unsure");
  const farMilestones = [task("a", "整理复习材料", "", { milestoneDeadline: "2026-10-20" }),
    task("b", "整理复习材料", "", { milestoneId: "m2", milestoneDeadline: "2026-12-17" })] as const;
  expect(comparePair(...farMilestones)).toMatchObject({ verdict: "unsure", score: 1 });
  // Not merged by code, not even at creation; the reviewer's yes merges them, its no keeps them two.
  expect(planMerges([...farMilestones]).groups).toEqual([]);
  expect(planMerges([...farMilestones]).unsure).toEqual([expect.objectContaining({ a: "a", b: "b", score: 1 })]);
  expect(planMerges([...farMilestones], new Set(["a|b"])).groups).toMatchObject([{ kind: "duplicate", absorb: ["b"] }]);
  expect(duplicateOf(farMilestones[1], [farMilestones[0]])).toBeUndefined();
  // Different numbers are a candidate, not a refusal: 作业 2 and 作业 3 are the reviewer's.
  expect(comparePair(task("a", "完成作业 2", "", { dueDate: "2026-10-01" }), task("b", "完成作业 3", "", { dueDate: "2026-10-30" })).verdict).toBe("unsure");
});

test("merge reasons are written in the person's language; a request is what its Skill marked", () => {
  const same = [task("a", "Gather the ECE 548 review notes", "midterm review", { progress: 0.5 }), task("b", "Gather ECE 548 review notes", "midterm review")];
  expect(planMerges(same, new Set(), "en").groups[0]!.reason).toBe('Duplicates "Gather the ECE 548 review notes" (same title)');
  expect(planMerges(same).groups[0]!.reason).toBe("与「Gather the ECE 548 review notes」重复（标题相同）");
  const request = [task("r", "Confirm the ECE 548 midterm scope", "", { request: { kind: "ask_person", what: "the ECE 548 midterm scope", who: "" } }),
    task("w", "Write the ECE 548 review outline", "", { dependsOn: ["r"] })];
  expect(planMerges(request, new Set(), "en").groups[0]!.reason).toBe('"Confirm the ECE 548 midterm scope" only asks someone, so it becomes the first step of "Write the ECE 548 review outline", which it serves');
  // Unmarked, the same title is ordinary work: nothing is folded.
  expect(planMerges([{ ...request[0]!, request: null }, request[1]!]).groups).toEqual([]);
});
