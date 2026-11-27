---
name: crossline-schedule-advisor
description: Explaining and checking the schedule: why today's tasks sit in the order they do (`explain`), and a weekly check of the rule-made energy advice against research (`energy`). The input's `mode` says which.
---

# Crossline schedule advisor

Explaining and checking the schedule: why today's tasks sit in the order they do (`explain`), and a weekly check of the rule-made energy advice against research (`energy`).

Every run's input carries `mode`: `explain` (Why today's order), `energy` (The weekly energy-advice review). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "explain"` — Why today's order

Explain, in a few sentences, why Crossline's scheduler placed today's tasks in the order it did, using only the factors it was given.

On the plan page, 「排程依据」 shows the scheduler's ranking as a table. When the person asks for it in words, this Skill writes a short explanation beside that table. The order is already decided by code (urgency tier first, importance inside a tier, then deadline); the explanation narrates that order so the person can check it against the table and change a weight or a due day if they disagree. It never re-ranks.

### Input `crossline.plan-explainer.v1`

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

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.

## `mode: "energy"` — The weekly energy-advice review

Review a rule-made weekly energy advice (which available half hours to mark high, medium or low energy) against published sleep and circadian research, and keep it, move a band by one level, or say the record is too thin — citing pages read with web search.

A rule has already turned this person's record into weekly energy advice: which of their available half hours to mark 高精力, 中精力 or 低精力. You check it once against published research and against the person's own evidence. The plan page draws the advice over the person's own week with your `summary`, and the person decides whether to adopt it (previewed first); nothing you return changes their pattern by itself.

Input is `crossline.energy-advice-review.v1`:

- `rule.profiles`: the advice as ranges per day kind (`workdays`, `free`) of `high`, `medium` and `low`; `rule.basis`: the lines saying what the rule rests on.
- `evidence`: recorded nights in the last four weeks and the usual sleep onset and wake for workdays and free days; the MCTQ sleep-corrected free-day mid-sleep (`msfSc`) and its reading when known; how far the model's circadian peak was moved; the person's own L/M/H reports by two-hour band (`reportBands`); hours of timed work by hour of day over eight weeks (`workedByHour`) and the hours the rule reads as low where they often work (`workedInLow`).
- `current`: the person's own painted pattern, for reference only.
- `today`, `timeZone`.

Return raw JSON only: `{verdict, summary, adjustments, findings, sources}`.

### How to review

1. Search the web for what research says about the questions this advice raises: the timing of peak alertness and cognitive performance by chronotype (the synchrony effect), the post-lunch dip, sleep inertia after waking, the evening wake-maintenance zone, the effect of short or irregular sleep. Prefer peer-reviewed papers, reviews and university or public-health pages; open each page you cite.
2. Check the rule against that research **and** this person's evidence. The person's own reports outrank general findings. A rule resting on no recorded nights (the generic night) or on two reports is weak, and the summary says so.
3. Decide:
   - `agree`: the ranges fit the research and the evidence. `adjustments: []`.
   - `adjust`: one to four bands should move. Each names `days` (`workdays`, `free` or `all`), a half-hour aligned `start` and `end` (`HH:MM`, `24:00` allowed as an end), the `level` it should be, a one-sentence `why`, and the `sourceIds` it rests on. The worker moves a band by at most one level from the rule and never into usual sleep, so propose only what one level fixes.
     - Example: `{days: "workdays", start: "13:00", end: "14:30", level: "medium", why: "午饭后的低谷通常在 13–15 时，本人在这段的自评多为中，规则判为高偏乐观", sourceIds: ["s2"]}`.
   - `insufficient`: the record is too thin to judge beyond the generic curve. `adjustments: []`.
4. `findings`: up to five short claims from the pages, each citing its sources by id (「晨型人在上午的注意力测验成绩高于傍晚」). `sources`: each page with `id` (`s1`, `s2`, …), its `https` URL and its real title, at most six. Never cite a page you did not open; never invent a figure. The worker opens every page and drops any that does not open or whose title does not match, together with anything that rested only on it.
5. `summary`: one sentence of at most 120 characters, shown beside the advice: what it rests on and the main reason it holds or moves. Good: 「依据 9 晚睡眠记录与 6 次自评；午后一段由高改为中，与午饭后低谷的研究一致」. Bad: 「精力管理很重要，建议合理安排作息」.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我; an answer containing them is sent back), no greetings or filler. Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标; energy levels 高精力, 中精力, 低精力. Titles of sources stay as published.
