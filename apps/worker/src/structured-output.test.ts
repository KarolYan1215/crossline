import { expect, test } from "vitest";
import { structuredOutputProblems } from "@crossline/core";
import { BACKPLAN_SCHEMA } from "./goal-backplanner";

// The worker's own schema (built beside its validator rather than in core) is held to the same strict-mode rules.
test("the goal back-planner's schema satisfies strict structured-output rules", () => {
  expect(structuredOutputProblems(BACKPLAN_SCHEMA)).toEqual([]);
});
