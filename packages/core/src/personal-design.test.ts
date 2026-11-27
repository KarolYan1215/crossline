import { expect, test } from "vitest";
import { DESIGN_NOTE_MAX, designNoteText, designProblem, knobValue, readDesign, skillNote, withEntry } from "./personal-design";

const skills = new Set(["crossline-task-planner:steps"]);
test("a knob takes only an integer in its range; an empty value resets", () => {
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "5" }, skills)).toBe("");
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "" }, skills)).toBe("");
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "40" }, skills)).toMatch(/^DESIGN_VALUE_OUT_OF_RANGE/);
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "2.5" }, skills)).toMatch(/^DESIGN_VALUE_OUT_OF_RANGE/);
  expect(designProblem({ kind: "knob", id: "made.up", value: "1" }, skills)).toMatch(/^DESIGN_KNOB_UNKNOWN/);
  expect(designProblem({ kind: "skill", id: "crossline:crossline-task-planner:steps", value: "先给结论" }, skills)).toBe("");
  expect(designProblem({ kind: "skill", id: "crossline-unknown", value: "x" }, skills)).toMatch(/^DESIGN_SKILL_UNKNOWN/);
  expect(designProblem({ kind: "skill", id: "crossline-task-planner:steps", value: "x".repeat(DESIGN_NOTE_MAX + 1) }, skills)).toMatch(/^DESIGN_NOTE_TOO_LONG/);
});

test("the person's value wins unless paused; bad entries are dropped on read", () => {
  let design = readDesign({ entries: [{ kind: "knob", id: "tutorial.leadDays", value: 99, at: "" }, { kind: "skill", id: "x", text: " ", at: "" }] });
  expect(design.entries).toEqual([]);
  expect(knobValue(design, "tutorial.leadDays")).toBe(3);
  design = withEntry(design, "knob", "tutorial.leadDays", { kind: "knob", id: "tutorial.leadDays", value: 7, at: "" });
  expect(knobValue(design, "tutorial.leadDays")).toBe(7);
  expect(knobValue(withEntry(design, "knob", "tutorial.leadDays", { kind: "knob", id: "tutorial.leadDays", value: 7, at: "", paused: true }), "tutorial.leadDays")).toBe(3);
  design = withEntry(design, "skill", "crossline-task-planner:steps", { kind: "skill", id: "crossline-task-planner:steps", text: "先给结论", at: "" });
  expect(skillNote(design, "crossline:crossline-task-planner:steps")).toBe("先给结论");
  expect(designNoteText("先给结论")).toContain("safety rules and output format still win");
});
