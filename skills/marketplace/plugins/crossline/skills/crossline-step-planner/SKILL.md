---
name: crossline-step-planner
description: Choose a task's archetype and write its step graph — roles, deliverables, done criteria, progress shares, estimates and ticks — worked backwards from the task's size and window.
---

# Crossline Step Planner

Input is `crossline.step-plan.v1`: one task (`task`: intent, line, project, the person's part, what the system may prepare, evidence it must deliver), the milestone it serves (title, deadline, criteria), its window (`window.notBefore` = earliest start, `window.dueBy` = latest finish, `window.availableMinutes` = working time inside it), uploaded materials by name, the archetype registry, steps already done (when replanning), the person's preferences, and `feedback` (what a reviewer or the person asked to change). Return raw JSON only: `{archetypeId, quantity, rationale, steps}`.

**Choose the archetype.** Pick the one archetype in `archetypes` whose structure matches the work. The person never picks it; a wrong choice is corrected later through the assistant, so choose on the evidence in the task, not on keywords alone.

**Work backwards from the size.** State the size in `quantity` (`basis`, `amount`, `unit`, using the archetype's `quantify` basis when it fits: problems, pages, thousand characters, knowledge points…). If the materials or the task state the amount, use it; otherwise estimate it and say so in `rationale`. The total of the steps' `p50Minutes` should fall inside `amount × minutesPerUnit`; `p85Minutes` carries the margin (1.2–3× p50), `p25Minutes` the optimistic case.

**Write the steps.** The archetype is a grammar, not a sequence:
- Use its `roles`; a role may occur several times and roles may interleave (research → execute → execute → research is fine). Keep its `requires`, its `firstBefore` rules and, when given, `endsWith`.
- A step is one working session: at least 15 minutes (`p50Minutes` ≥ 15), except a waiting step. Merge small actions (confirm a version, list fields) into the session they belong to rather than listing a 5-minute step.
- `acceptedOutputs` already exist (the assistant produced them and the person accepted them): build on them; do not plan to produce them again, and do not report them as missing.
- As many steps as the work needs, no fixed count. Multiple instances (problem 1…n) may be grouped by session rather than listed one by one when they are small.
- A check that may fail opens one round of revision only; further rounds are planned later if the check fails (do not pre-plan loops).
- Near-term steps are specific; later ones may be coarser (rolling-wave planning). When replanning, keep what `doneSteps` already achieved and plan only what remains.
- Each step: `id` (unique here), `role`, `title` (a short imperative), `deliverable` (what exists afterwards), `doneCriterion` (quantified where possible: 「完成第 1–3 题并核对答案」, 「初稿 1500 字」), `share` (its part of the task's progress; shares sum to 1, proportional to effort and value), `estimate`, `dependsOn` (earlier step ids), `notBefore`/`dueBy` (`YYYY-MM-DD` or `""`; inside the window), `schedulable` (false only for waiting), `executor`, `tickOutcome`.
- `executor`: `agent` when the system can do the step on its own from the given inputs and public sources (gathering, listing, organising, drafting a checklist), `mixed` when it can prepare and the person finishes, `human` when it needs the person's judgement, presence, account or graded work. Graded coursework is never `agent`. Choosing or deciding is never `agent`.
- `tickOutcome`: for the steps whose result is a meaningful near-term achievement, a result written as a capability or an artefact following the archetype's `tickHint` (「能独立推导 BJT 小信号模型」, 「第 1–3 题完成」); `""` for routine steps. Two to five ticks per task is typical.

Never invent facts about the person, the course or the materials; if the amount or a date is unknown, say what you assumed in `rationale`. Do not set goals, deadlines or importance. Do not plan external sending, publishing, payment or trading as anything other than the person's own step.

Write every human-readable field in Chinese: objective, third person, standard academic and workplace terms, no second person, no invented jargon.
