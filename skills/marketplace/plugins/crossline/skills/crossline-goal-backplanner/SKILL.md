---
name: crossline-goal-backplanner
description: Turn one approved milestone into sourced, dependency-aware work-order drafts with p25/p50/p85 estimates.
---

# Crossline Goal Backplanner

Input is `crossline.goal-backplan.v2`: one approved milestone with its exact identity, project, title, criteria, source text and existing work, plus what the person has said about inputs: `suppliedInputs` (handed over, with their text), `waitingInputs` (on their way, who and roughly when) and, in the second mode, `missingInputs`. Work backwards from what the criteria require, then propose the tasks that deliver it. Each item in `steps` becomes one task in the person's list, so it is a coherent piece of work with one deliverable (an outline, a set of solved problems, a draft) — not a single action. The step planner splits each task into its own steps, estimates and ticks afterwards; do not list those internal steps as separate items. Return raw JSON only, with `steps`, `dateCandidates` and `blockers` arrays.

Each step has `{id, intent, sourceQuote, rationale, dependsOn, estimate: {p25Minutes,p50Minutes,p85Minutes}, energy, interruptible, family, riskTier, evidence, acquires}`. `id` is unique within this response. `sourceQuote` must be an exact excerpt of the provided title, criterion statement, original request, a supplied input, or (second mode) a missing input's `message`; never invent a user quote. `dependsOn` names earlier step ids only. Durations are positive minutes with p25 <= p50 <= p85. `energy` is low, medium or high. `family` is `preparation` (gathering, setting up, reading in), `review` (checking, assessing, revising) or `deep_work` (producing the thing itself) — it is how the person's real durations are pooled to correct later estimates. `riskTier` is routine, milestone or high_risk. `evidence` says what a person could show after completing the step.

**Missing inputs, first mode** (`missingInputs` is empty). If a step needs something that is in none of the sources — data, a specification, a version, someone's decision — do not invent it and do not guess. Return it as a blocker: `{code, message, what, whoHas}`, where `what` names the input in a few words (「MoS₂ 实测参数数据」), `whoHas` is who can provide it if the sources say so (「师兄」) or `""`, and `message` is one sentence on why the steps need it. One blocker per missing thing. Every step's `acquires` is `""`. The person is asked about each blocker.

**Second mode** (`missingInputs` is not empty). Those inputs are known to be missing and the person is being asked about them. Do not block on them: make obtaining or confirming each one a step of its own (asking the person who has it, locating the file, confirming a version), with `acquires` set to that input's `id` and `sourceQuote` an exact excerpt of its `message`. Steps that need the input depend on that step. Every other step has `acquires` `""`. Return blockers only for what the milestone itself leaves unclear.

`waitingInputs` are already on their way: order the steps that do not need them first.

Keep source and inference distinct: the quote is the source, the rationale is your inference. A draft is still awaiting the user's approval; do not claim it was approved or scheduled. Do not add a new goal, change importance, set a deadline, or change acceptance criteria. Never put external communication, financial transactions, legal commitments, publication or destructive changes in `routine`.

When the supplied original request states a calendar date, list it as `{date: "YYYY-MM-DD", quote}` in `dateCandidates`; `quote` must be an exact excerpt. These are suggestions for the person to confirm, not deadlines. If a relative date cannot be grounded to an exact day, leave the list empty.

Allowed tools: read-only local context and web research when necessary. Budget: premium. Risk: milestone.
