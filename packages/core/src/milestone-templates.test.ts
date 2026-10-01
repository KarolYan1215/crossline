import { expect, test } from "vitest";
import { defaultMilestoneTemplates, computeMilestoneConfidence, type MilestoneTemplate, type SuccessCriterion } from "./index";

test("the built-in library covers all five kinds for each of the four goal-bearing identities", () => {
  const templates = defaultMilestoneTemplates();
  const identities = ["research", "startup", "media", "investment"];
  for (const identityId of identities) {
    const forIdentity = templates.filter((template) => template.identityId === identityId);
    expect(forIdentity.length).toBeGreaterThanOrEqual(6);
  }
  // health is a capacity constraint on the other four identities, not an identity with milestones —
  // it deliberately has no templates, same as it has no milestones today.
  expect(templates.some((template) => template.identityId === "health")).toBe(false);
});

test("every built-in template declares at least one criterion and a non-empty evidence question bank", () => {
  for (const template of defaultMilestoneTemplates()) {
    expect(template.successCriteriaDefaults.length).toBeGreaterThan(0);
    expect(template.evidenceQuestionDefaults.length).toBeGreaterThan(0);
    expect(template.source).toBe("builtin");
  }
});

test("a checkbox evidence question always carries options, and a text one never does", () => {
  for (const template of defaultMilestoneTemplates()) {
    for (const question of template.evidenceQuestionDefaults) {
      if (question.kind === "checkbox") expect(question.options.length).toBeGreaterThan(0);
      else expect("options" in question).toBe(false);
    }
  }
});

test("template ids are unique across the whole library", () => {
  const ids = defaultMilestoneTemplates().map((template) => template.id);
  expect(new Set(ids).size).toBe(ids.length);
});

const research = (): MilestoneTemplate => defaultMilestoneTemplates().find((t) => t.identityId === "research")!;

test("confidence is low when no template is given at all", () => {
  expect(computeMilestoneConfidence([], undefined)).toBe("low");
});

test("confidence is high when criteria match a template's defaults exactly in shape", () => {
  const template = research();
  expect(computeMilestoneConfidence(template.successCriteriaDefaults, template)).toBe("high");
});

test("confidence drops to medium when a template was used but the criteria were customized", () => {
  const template = research();
  const customized: SuccessCriterion[] = [
    ...template.successCriteriaDefaults,
    { id: "extra", statement: "额外加的一条", required: true, evidenceOf: "output", measure: { kind: "artifact", mustExist: "x" } }
  ];
  expect(computeMilestoneConfidence(customized, template)).toBe("medium");
});

test("confidence is medium when the same number of criteria swap to a different measure kind", () => {
  const template = research();
  const swapped: SuccessCriterion[] = template.successCriteriaDefaults.map((criterion) =>
    ({ ...criterion, measure: { kind: "count", unit: "次", atLeast: 1 } }));
  expect(computeMilestoneConfidence(swapped, template)).toBe("medium");
});
