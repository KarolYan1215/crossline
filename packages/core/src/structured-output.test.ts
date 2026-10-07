import { expect, test } from "vitest";
import * as core from "./index";
import { structuredOutputProblems } from "./structured-output";

/**
 * Discovery, not a list: every exported `*_SCHEMA` object is checked, so a new Skill's schema is held to the strict-mode
 * rules the day it is exported instead of failing at its first real run.
 */
const named = Object.entries(core).filter(([name, value]) =>
  /_SCHEMA$/.test(name) && typeof value === "object" && value !== null && "properties" in (value as object));

test("the discovery finds the Skills' schemas (a rename that hides one from it fails here)", () => {
  expect(named.map(([name]) => name)).toEqual(expect.arrayContaining([
    "ANALYSIS_OUTPUT_SCHEMA", "ONBOARDING_TURN_SCHEMA", "MILESTONE_GATE_OUTPUT_SCHEMA", "MANUAL_DESIGN_SCHEMA", "DILIGENCE_OUTPUT_SCHEMA",
    "MATERIAL_SEARCH_SCHEMA", "NODE_WRITEUP_SCHEMA", "FLYWHEEL_OUTPUT_SCHEMA", "MILESTONE_PROPOSAL_SCHEMA", "BACKPLAN_SCHEMA"
  ]));
});

test.each(named)("%s satisfies strict structured-output rules", (_name, schema) => {
  expect(structuredOutputProblems(schema)).toEqual([]);
});

test("the checker itself refuses what strict mode refuses", () => {
  expect(structuredOutputProblems({ type: "object", properties: { a: { type: "string" } }, required: [], additionalProperties: false }))
    .toEqual([expect.stringContaining("$.a: not in required")]);
  expect(structuredOutputProblems({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }))
    .toEqual([expect.stringContaining("additionalProperties must be false")]);
  expect(structuredOutputProblems({ anyOf: [] })).toEqual([expect.stringContaining("root must be an object")]);
  expect(structuredOutputProblems({ type: "object", properties: { a: { oneOf: [] } }, required: ["a"], additionalProperties: false }))
    .toEqual([expect.stringContaining('"oneOf"')]);
});
