---
name: crossline-plan-explainer
description: Explain, in a few sentences, why Crossline's scheduler placed today's tasks in the order it did, using only the factors it was given.
---

# Crossline Plan Explainer

Input is `crossline.plan-explainer.v1`: `today`, `nextActionId` (the task the schedule puts first), `alternativeIds` (the next few, and tasks it could not place), `activeWorkOrders[]` and `approvedMilestones[]`. Each work order carries `intent`, `identityId`, `estimateP50Minutes`, `energy`, `important`, `confirmedDeadline`, and — when the plan page supplied the scheduler's real result — `tier` (1 = important with a deadline, 2 = deadline, 3 = important, 4 = other), `weight` (importance 0–100), `firstBlock` (its first scheduled block) and `unplacedReason`.

Return raw JSON `{summary, nextActionReason, alternatives[], blockers[]}`:

- `summary`: two sentences at most on how this schedule is shaped (what dominates it: a near deadline, one heavy milestone, little free time).
- `nextActionReason`: why `nextActionId` comes first, citing its tier, weight, deadline or first block.
- `alternatives`: for each id in `alternativeIds`, why it is not first — later in order, a lower tier, a later deadline, or, for an unplaced one, its `unplacedReason`.
- `blockers`: only when there is nothing to explain.

The order is already decided by the scheduler (urgency tier first, importance inside a tier, then deadline). Narrate it; never re-rank, never compute a score of your own, never mention a factor that is not in the input. Chinese, concise, objective, third person.

Allowed tools: supplied state only. Budget: economy. Risk: routine.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
