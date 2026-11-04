import { expect, test } from "vitest";
import { designNoteText, designProblem, knobValue, readDesign, skillNote, withEntry } from "./personal-design";

const skills = new Set(["crossline-step-planner"]);
test("a knob takes only an integer in its range; an empty value resets", () => {
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "5" }, skills)).toBe("");
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "" }, skills)).toBe("");
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "40" }, skills)).toMatch(/^DESIGN_VALUE_OUT_OF_RANGE/);
  expect(designProblem({ kind: "knob", id: "tutorial.leadDays", value: "2.5" }, skills)).toMatch(/^DESIGN_VALUE_OUT_OF_RANGE/);
  expect(designProblem({ kind: "knob", id: "made.up", value: "1" }, skills)).toMatch(/^DESIGN_KNOB_UNKNOWN/);
  expect(designProblem({ kind: "skill", id: "crossline:crossline-step-planner", value: "先给结论" }, skills)).toBe("");
  expect(designProblem({ kind: "skill", id: "crossline-unknown", value: "x" }, skills)).toMatch(/^DESIGN_SKILL_UNKNOWN/);
  expect(designProblem({ kind: "skill", id: "crossline-step-planner", value: "x".repeat(601) }, skills)).toMatch(/^DESIGN_NOTE_TOO_LONG/);
});

test("the person's value wins unless paused; bad entries are dropped on read", () => {
  let design = readDesign({ entries: [{ kind: "knob", id: "tutorial.leadDays", value: 99, at: "" }, { kind: "skill", id: "x", text: " ", at: "" }] });
  expect(design.entries).toEqual([]);
  expect(knobValue(design, "tutorial.leadDays")).toBe(3);
  design = withEntry(design, "knob", "tutorial.leadDays", { kind: "knob", id: "tutorial.leadDays", value: 7, at: "" });
  expect(knobValue(design, "tutorial.leadDays")).toBe(7);
  expect(knobValue(withEntry(design, "knob", "tutorial.leadDays", { kind: "knob", id: "tutorial.leadDays", value: 7, at: "", paused: true }), "tutorial.leadDays")).toBe(3);
  design = withEntry(design, "skill", "crossline-step-planner", { kind: "skill", id: "crossline-step-planner", text: "先给结论", at: "" });
  expect(skillNote(design, "crossline:crossline-step-planner")).toBe("先给结论");
  expect(designNoteText("先给结论")).toContain("safety rules and output format still win");
});
