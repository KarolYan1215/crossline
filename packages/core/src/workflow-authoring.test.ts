import { expect, test } from "vitest";
import { dryRunAutomation, lineDiff, nextScheduleTimes, renderAutomationVersion, validateWorkflowTurn, type AutomationDefinition } from "./workflow-authoring";

const definition: AutomationDefinition = { name: "整理邮件", summary: "每天整理", lineId: "research",
  trigger: { type: "schedule", schedule: { type: "daily", time: "08:00" } },
  action: { kind: "run", instructions: "读新邮件，整理成清单", category: "read_research_organize", outputs: ["list.md"] },
  steps: [{ title: "整理", by: "assistant" }, { title: "回复老师的邮件", by: "assistant" }] };

test("a line diff keeps what is the same and marks what was removed and added", () => {
  expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([{ op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "x" }, { op: "same", text: "c" }]);
  expect(lineDiff("a", "a")).toEqual([{ op: "same", text: "a" }]);
  expect(lineDiff("a\nb", "a\nb", 1).filter((line) => line.op !== "same")).toHaveLength(4);
});

test("the next times of a schedule are found in the person's zone", () => {
  const next = nextScheduleTimes({ type: "daily", time: "08:00" }, new Date("2026-11-10T20:00:00Z"), "Asia/Shanghai");
  expect(next).toEqual(["2026-11-11T00:00:00.000Z", "2026-11-12T00:00:00.000Z", "2026-11-13T00:00:00.000Z"]);
  expect(nextScheduleTimes({ type: "weekly", days: ["FR"], time: "18:30" }, new Date("2026-11-10T00:00:00Z"), "UTC", 1)).toEqual(["2026-11-13T18:30:00.000Z"]);
});

test("a dry run says what would happen without running, and hands a step that sends to the person", () => {
  const run = dryRunAutomation({ ...definition, createdAt: "2026-11-01T00:00:00Z" }, 2, { now: new Date("2026-11-10T20:00:00Z"), zone: "Asia/Shanghai", categoryOn: false });
  expect(run.next).toHaveLength(3);
  expect(run.prompt).toContain("读新邮件，整理成清单");
  expect(run.steps.find((step) => step.title.startsWith("回复"))).toMatchObject({ leaves: true, by: "assistant" });
  expect(run.checks.filter((check) => !check.ok)).toHaveLength(2);
});

test("a turn's answer is checked: a change to an automation is always to this one, a grown workflow is revised in words", () => {
  const plan = { name: "整理邮件", summary: "s", lineId: "research",
    trigger: { type: "interval", time: "", days: "", hours: 6, from: "", keywords: "", url: "", event: "" },
    action: { kind: "run", instructions: "读新邮件，整理成清单写进文件", reminder: "", category: "read_research_organize", outputs: "list.md" },
    steps: [{ title: "整理", by: "assistant" }], assumptions: "", replaces: "", enabled: true, runNow: false };
  const answer = validateWorkflowTurn({ reply: "改成每 6 小时", change: "automation", plan, revision: "" }, { kind: "automation", workflowId: "auto-a", lineIds: ["research"] });
  expect(answer).toMatchObject({ change: "automation", plan: { replaces: "auto-a", trigger: { type: "interval", hours: 6 } } });
  expect(() => validateWorkflowTurn({ reply: "", change: "none", plan, revision: "" }, { kind: "automation", workflowId: "", lineIds: ["research"] })).toThrow("WORKFLOW_TURN_INVALID");
  expect(() => validateWorkflowTurn({ reply: "好", change: "automation", plan, revision: "" }, { kind: "grown", workflowId: "flow-a", lineIds: ["research"] })).toThrow();
  expect(validateWorkflowTurn({ reply: "好", change: "revise", plan, revision: "多读一页收藏夹" }, { kind: "grown", workflowId: "flow-a", lineIds: [] }))
    .toEqual({ reply: "好", change: "revise", revision: "多读一页收藏夹" });
});

test("a version renders as text a diff can compare", () => {
  const text = renderAutomationVersion(definition);
  expect(text).toContain("整理邮件");
  expect(text.split("\n").some((line) => line.includes("回复老师的邮件"))).toBe(true);
});
