import { expect, test } from "vitest";
import { OTHER_SKILLS, modelChoiceFor, modelChoiceProblem, modelChoicesOf, withModelChoice } from "./model-choice";

test("a Skill takes its own choice, else the one for every other Skill, else none", () => {
  const choices = modelChoicesOf(JSON.stringify({ "crossline-onboarding": { model: "gpt-5.6-sol", effort: "high" }, [OTHER_SKILLS]: { model: "gpt-5.6-terra" } }));
  expect(modelChoiceFor(choices, "crossline:crossline-onboarding")).toEqual({ model: "gpt-5.6-sol", effort: "high" });
  expect(modelChoiceFor(choices, "crossline:crossline-step-planner")).toEqual({ model: "gpt-5.6-terra" });
  expect(modelChoiceFor({}, "crossline:crossline-step-planner")).toBeUndefined();
});

test("an unreadable or malformed setting counts as no choice, never a guess", () => {
  expect(modelChoicesOf("not json")).toEqual({});
  expect(modelChoicesOf("[]")).toEqual({});
  // Unknown slots, bad efforts and pasted paragraphs are dropped one by one.
  expect(modelChoicesOf(JSON.stringify({ "crossline-made-up": { model: "a" }, "crossline-onboarding-extract": { model: "gpt-5.6-sol", effort: "max" },
    "crossline-onboarding-research": { model: "two words" }, [OTHER_SKILLS]: { model: "gpt-5.6-luna", effort: "low" } })))
    .toEqual({ [OTHER_SKILLS]: { model: "gpt-5.6-luna", effort: "low" } });
  expect(modelChoiceProblem({ model: "qwen3:8b" })).toBeUndefined();
  expect(modelChoiceProblem({ model: "" })).toBe("INVALID_MODEL");
  expect(modelChoiceProblem({ model: "gpt", effort: "ultra" })).toBe("INVALID_EFFORT");
});

test("a slot is set or cleared back to the route table", () => {
  const set = withModelChoice({}, "crossline-onboarding", { model: "gpt-5.6-sol", effort: "xhigh" });
  expect(set).toEqual({ "crossline-onboarding": { model: "gpt-5.6-sol", effort: "xhigh" } });
  expect(withModelChoice(set, "crossline-onboarding", null)).toEqual({});
});

test("the input box and the assistant each have a slot; the tools-mode assistant shares the assistant's", () => {
  const choices = modelChoicesOf(JSON.stringify({ "crossline-concierge": { model: "gpt-6-luna" }, "crossline-agent": { model: "gpt-6.2-sol", effort: "high" } }));
  expect(modelChoiceFor(choices, "crossline:crossline-concierge")).toEqual({ model: "gpt-6-luna" });
  expect(modelChoiceFor(choices, "crossline:crossline-agent")).toEqual({ model: "gpt-6.2-sol", effort: "high" });
  expect(modelChoiceFor(choices, "crossline:crossline-agent-tools")).toEqual({ model: "gpt-6.2-sol", effort: "high" });
  expect(modelChoiceFor(choices, "crossline:crossline-step-planner")).toBeUndefined();
});
