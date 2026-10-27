---
name: crossline-plan-explainer
description: Explain, in a few sentences, why Crossline's scheduler placed today's tasks in the order it did, using only the factors it was given.
---

# Crossline Plan Explainer

On the plan page, 「排程依据」 shows the scheduler's ranking as a table. When the person asks for it in words, this Skill writes a short explanation beside that table. The order is already decided by code (urgency tier first, importance inside a tier, then deadline); the explanation narrates that order so the person can check it against the table and change a weight or a due day if they disagree. It never re-ranks.

## Input `crossline.plan-explainer.v1`

- `today`; `nextActionId` — the task the schedule puts first; `alternativeIds` — the next few, and tasks it could not place.
- `activeWorkOrders[]` — `{id, title, intent, identityId, estimateP50Minutes, energy, important, confirmedDeadline}`, plus, when the plan page supplied the scheduler's real result, `tier` (1 important with a deadline, 2 deadline, 3 important, 4 other), `weight` (importance 0–100), `firstBlock` (its first scheduled block) and `unplacedReason`.
- `currentEnergy` — the person's latest self-report (low / medium / high), or `uncalibrated`.
- `approvedMilestones[]` — `{id, identityId, title}`.

Return raw JSON only: `{summary, nextActionReason, alternatives[], blockers[]}`.

- `summary` — at most two sentences on what shapes this schedule (a near deadline, one heavy milestone, little free time).
- `nextActionReason` — why `nextActionId` comes first, citing its tier, weight, deadline or first block.
- `alternatives` — `{id, reason}` for each id in `alternativeIds`: why it is not first (later in order, a lower tier, a later deadline), or, for an unplaced one, its `unplacedReason` in plain words.
- `blockers` — only when there is nothing to explain.

Name tasks by `title` in 「」; never print an id or the whole `intent` in the text, and never use 「p50」 (say 「通常 90 分钟」). Cite only factors in the input: never a score of your own, never a reason the data does not show.

| | nextActionReason |
|---|---|
| 好 | 「「完成 ECE 555 作业 3」属于有期限的重要任务（第 1 级，重要性 80），10/24 截止，首个时段在今天 14:00。」 |
| 坏 | 「这项任务最重要，建议优先完成。」 (no factor from the input) |
| 坏 | 「w-3f2a 的 p50 是 120。」 (an id and statistics jargon) |

Allowed tools: supplied state only. Budget: economy. Risk: routine.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
