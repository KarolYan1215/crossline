---
name: crossline-goal-backplanner
description: Turn one approved milestone into sourced, dependency-aware work-order drafts with p25/p50/p85 estimates.
---

# Crossline Goal Backplanner

Input is `crossline.goal-backplan.v1`: one approved milestone with its exact identity, project, title, criteria, source text and existing work. Work backwards from what the criteria require, identify missing inputs, then propose the smallest useful steps. Return raw JSON only, with `steps`, `dateCandidates` and `blockers` arrays.

Each step has `{id, intent, sourceQuote, rationale, dependsOn, estimate: {p25Minutes,p50Minutes,p85Minutes}, energy, interruptible, riskTier, evidence}`. `id` is unique within this response. `sourceQuote` must be an exact excerpt of the provided title, criterion statement, or original request; never invent a user quote. `dependsOn` names earlier step ids only. Durations are positive minutes with p25 <= p50 <= p85. `energy` is low, medium or high. `riskTier` is routine, milestone or high_risk. `evidence` says what a person could show after completing the step.

If a critical input is absent, return a blocker naming it instead of inventing a step. Keep source and inference distinct: the quote is the source, the rationale is your inference. A draft is still awaiting the user's approval; do not claim it was approved or scheduled. Do not add a new goal, change importance, set a deadline, or change acceptance criteria. Never put external communication, financial transactions, legal commitments, publication or destructive changes in `routine`.

When the supplied original request states a calendar date, list it as `{date: "YYYY-MM-DD", quote}` in `dateCandidates`; `quote` must be an exact excerpt. These are suggestions for the person to confirm, not deadlines. If a relative date cannot be grounded to an exact day, leave the list empty and put the ambiguity in `blockers` only if it blocks the steps themselves.

Allowed tools: read-only local context and web research when necessary. Budget: premium. Risk: milestone.
