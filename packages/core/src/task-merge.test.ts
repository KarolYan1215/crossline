import "@crossline/i18n/catalog/worker";
import { expect, test } from "vitest";
import { comparePair, normalizeTaskTitle, planMerges, type MergeTask } from "./task-merge";

const task = (id: string, title: string, intent = "", extra: Partial<MergeTask> = {}): MergeTask => ({ id, identityId: "research", projectId: "ece548",
  milestoneId: "m1", title, intent, state: "approved", dueDate: "", milestoneDeadline: "", progress: 0, hasStepPlan: false, started: false, dependsOn: [], ...extra });

test("Chinese titles are compared as before", () => {
  expect(normalizeTaskTitle("汇集 ECE 548 复习资料")).toBe(normalizeTaskTitle("整理 ECE 548 复习材料"));
  expect(comparePair(task("a", "汇集 ECE 548 复习材料", "期中复习"), task("b", "整理 ECE 548 复习材料", "期中复习")).verdict).toBe("same");
});

test("English titles: synonymous verbs and filler words set aside, numbers and labels kept apart", () => {
  expect(normalizeTaskTitle("Gather the ECE 548 review notes")).toBe(normalizeTaskTitle("Compile ECE 548 review materials"));
  expect(comparePair(task("a", "Gather the ECE 548 review notes", "midterm review"), task("b", "Compile ECE 548 review materials", "midterm review")).verdict).toBe("same");
  expect(comparePair(task("a", "Homework 2"), task("b", "Homework 3")).verdict).toBe("different");
  expect(normalizeTaskTitle("Homework A")).not.toBe(normalizeTaskTitle("Homework B"));
});

test("merge reasons are written in the person's language", () => {
  const same = [task("a", "Gather the ECE 548 review notes", "midterm review", { progress: 0.5 }), task("b", "Compile ECE 548 review materials", "midterm review")];
  expect(planMerges(same, new Set(), "en").groups[0]!.reason).toMatch(/^Duplicates "Gather the ECE 548 review notes" \(titles/);
  expect(planMerges(same).groups[0]!.reason).toMatch(/^与「Gather the ECE 548 review notes」重复（标题规范化后相似度/);
  const request = [task("r", "Confirm the ECE 548 midterm scope"), task("w", "Write the ECE 548 review outline", "", { dependsOn: ["r"] })];
  expect(planMerges(request, new Set(), "en").groups[0]!.reason).toBe('"Confirm the ECE 548 midterm scope" only asks someone, so it becomes the first step of "Write the ECE 548 review outline", which it serves');
});
