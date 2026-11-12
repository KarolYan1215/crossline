/**
 * The interview refactor's data contracts as the screen reads them (interview-implementation-plan.md B–D, 2026-11-12), from core under
 * the names the screen uses.
 */
import type { Hypothesis, InterviewCompleteness, ResearchThread } from "@crossline/core";

export { DIMENSION_IDS, PORTRAIT_DIMENSION_LABEL as DIMENSION_LABEL } from "@crossline/core";
export type { CareerOption, DimensionId, DimensionNote, Hypothesis, ResearchThread } from "@crossline/core";
export type HypothesisBasis = Hypothesis["basis"][number];
export type ResearchSource = NonNullable<ResearchThread["sources"]>[number];
/** `GET /api/onboarding/state`'s `completeness` (contract D). */
export type Completeness = InterviewCompleteness;
