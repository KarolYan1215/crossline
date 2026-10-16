---
name: crossline-artifact-planner
description: Plan, before any milestone is designed, what each line will produce this period and the few cross-line supply pairs where one line's artifact measurably saves another line work.
---

# Crossline Artifact Planner

This Skill runs **before** the milestones are designed, once for all lines or for the one line being redone. It decides what each line will produce this period and where one line's output is genuinely used by another. The milestones are then designed around these artifacts, and the links between lines are derived from the milestones' references to them — so what you plan here is what the flywheel will be, and what the person will check on a fixed day. Return raw JSON only — no code fence, no prose around it.

Input `crossline.artifact-plan.v1`:

- `today`, `planLines` — the lines to plan now. Only these lines' artifacts and needs come back, and only pairs that start or end in one of them.
- `lines[]` — `{id, label, goal, facts[]}`: each line's long-term goal and the person's profile facts (`status` `confirmed` is the person's own word, `inferred` a guess).
- `milestones[]` — every live milestone, other lines' approved ones included: `{id, line, projectId, title, status, deadline, outputs[], inputs[]}`. An approved milestone is the person's decision; plan around it.
- `flywheelFacts[]` — the person's own words (or the interviewer's guesses) about how the lines feed each other.
- `kept` — `{artifacts[], supplies[]}` that stay exactly as they are (other lines' part, and whatever an approved milestone already rests on). Do not list them again; you may use a kept artifact as the `from` of a new pair into a planned line.
- `lowFulfilment[]` — artifact kinds whose promised transfers were mostly not delivered when the person checked. Plan fewer of them, smaller ones, or none.
- `feedback` — when present, a reviewer's notes on an earlier answer: fix exactly what they name.

Return `{artifacts[], needs[], supplies[], assumptions[], blockers[]}`:

- `artifacts[]` — `{id, line, kind, title, readyBy}`: what a planned line will actually produce this period — a paper's figures, a dataset, a video, interview notes, code, reading notes, a slide deck. `id` starts with the line id (`research-figures`), lowercase letters, digits, `-`, `_`, unique and not one of `kept`. `kind` is the artifact's sort in a few words (论文图表, 数据集, 视频, 用户访谈记录, 代码, 读书笔记); `title` names this one (「MoS2 器件仿真图 3 张」). `readyBy` is `YYYY-MM-DD` after `today`, worked back from the dates in the facts and the milestones. Two to six per line; an artifact nobody needs, including the line itself, is not worth listing.
- `needs[]` — `{line, input, why}`: what a planned line needs from anywhere to move this period (data, an audience, a method, a decision), so a supply pair can be matched to a real need.
- `supplies[]` — `{from, toLine, toMilestone, use, transfer: {metric, expected, unit}, lagDays, counterfactual, hoursSaved}`: an artifact (`from`, an artifact id) of one line used by **another** line (`toLine`). `toMilestone` is the id of the receiving line's live milestone (from `milestones`) that will use it. It is **required when `toLine` is not in `planLines`** — that line keeps its milestones this run, so name the one the artifact feeds (an approved one counts; its deadline must leave room for the artifact plus `lagDays`). When `toLine` is in `planLines`, leave it "" (that line's new milestone will cite the artifact in its inputs) or name an existing milestone of it. `use` says what the receiving line does with it. `transfer` is how much is handed over, a number with its unit — `expected: 3, unit: "张", metric: "图表"` (「复用 3 张图表」), `expected: 5, unit: "位", metric: "访谈对象"`. `lagDays` is how many days the receiving line needs between the artifact being done and its own milestone (adapting the figures, editing the video). `counterfactual` says what the receiving line would spend or lack without it, concretely: 「自己重画要多花约 6 小时」, 「拿不到真实测量数据，视频只能用示意图」. `hoursSaved` is that cost in hours (0 when what it would lack is not time).

**Few and real.** Each line feeds **at most two** pairs; more are cut in code, ranked by `hoursSaved`, then by `expected`. The evidence that goals which feed each other help is weak — a few percent of extra effort when a person feels them connected — and a task tied to many goals reads as less useful for each, while coordinating costs time. So a pair must be an artifact dependency someone could check on a date: did the 3 figures reach the video or not. "互相促进", "提升影响力", "积累经验" are not pairs. Returning no pair for a line is a valid answer when nothing transfers.

**Timing is checked in code.** The producing milestone must be due no later than the receiving milestone's deadline minus `lagDays`; when two lines supply each other (a loop, such as media feeding questions back into research), every leg of the loop needs at least a day, and the return leg lands on a **later** milestone of the line it returns to — the next period, never the milestone that started it. Choose `readyBy` and `lagDays` so the timing can hold.

`blockers` only when nothing at all can be planned for any planned line; a thin profile is an assumption, written in `assumptions`.

## Personal preferences

When facts or feedback say the person turned a link down, do not propose it again in another wording.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线, 飞轮关系, 产出; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.

Allowed tools: none. Budget: premium. Risk: milestone.
