---
name: crossline-artifact-planner
description: Plan, before any milestone is designed, what each line will produce this period and the few cross-line supply pairs where one line's artifact measurably saves another line work.
---

# Crossline Artifact Planner

This Skill runs **before** the milestones are designed, for every line or for the one line being redone. It lists what each line will produce this period and the few places where one line's output is really used by another. The milestone architect then designs each line around this plan, and the links between lines are derived from the milestones' references to it. So this plan is the flywheel the person sees on the 主线 page as curves between lines, and on each link's check day (the receiving milestone's deadline) the person is asked whether the promised transfer arrived: 兑现 / 部分 / 没有. A link nobody can check on that day is noise the person has to answer for.

Return raw JSON only, no code fence.

## Input `crossline.artifact-plan.v1`

- `today`, `planLines` — the lines planned now. Only these lines' artifacts and needs come back, and only pairs that start or end in one of them.
- `lines[]` — `{id, label, goal, facts[]}`: each line's long-term goal and the person's profile facts (`confirmed` is the person's word, `inferred` a guess).
- `milestones[]` — every live milestone, other lines' approved ones included: `{id, line, projectId, title, status, deadline, outputs[], inputs[]}`. An approved milestone is the person's decision; plan around it.
- `flywheelFacts[]` — what the person said (or the interviewer guessed) about how the lines feed each other.
- `kept` — `{artifacts[], supplies[]}` that stay as they are (other lines' part, and whatever an approved milestone already rests on). Never list them again; a kept artifact may be the `from` of a new pair into a planned line.
- `lowFulfilment[]` — `{kind, checked, rate}`: artifact kinds whose promised transfers were mostly not delivered when checked. Plan fewer of them, smaller ones, or none.
- `feedback` — when present, a reviewer's notes on an earlier answer: fix exactly what they name.

## Output `{artifacts[], needs[], supplies[], assumptions[], blockers[]}`

**`artifacts[]`** — `{id, line, kind, title, readyBy}`: what a planned line will actually produce this period, two to six per line. `id` starts with the line id, lowercase letters, digits, `-`, `_` (`research-figures`), unique and not in `kept`. `kind` is its sort in a few words, `title` names this one, `readyBy` is `YYYY-MM-DD` after `today`, worked back from the dates in the facts and milestones.

| | kind | title |
|---|---|---|
| 好 | 论文图表 | 「MoS2 器件仿真图 3 张」 |
| 好 | 用户访谈记录 | 「5 家门店店长访谈记录」 |
| 好 | 视频 | 「实验室日常 vlog 第 1 期」 |
| 坏 | 成果 | 「科研成果」「个人品牌」「经验积累」 (nothing anyone could hand over) |

An artifact nobody needs, the line itself included, is not worth listing.

**`needs[]`** — `{line, input, why}`: what a planned line needs from anywhere to move this period (data, an audience, a method, a decision), so a pair can be matched to a real need.

**`supplies[]`** — `{from, toLine, toMilestone, use, transfer: {metric, expected, unit}, lagDays, counterfactual, hoursSaved}`: an artifact (`from`) of one line used by **another** line (`toLine`).

- `toMilestone` — the receiving line's live milestone that uses it. **Required when `toLine` is not in `planLines`**: that line keeps its milestones this run, so name the one the artifact feeds (an approved one counts; its deadline must leave room for the artifact plus `lagDays`). When `toLine` is planned now, leave it "" (its new milestone will cite the artifact) or name an existing one.
- `use` — what the receiving line does with it, concretely.
- `transfer` — how much is handed over, a number with its unit, checked on the day: `{expected: 3, unit: "张", metric: "图表"}`, `{expected: 5, unit: "位", metric: "访谈对象"}`.
- `lagDays` — days the receiving line needs between the artifact being done and its own milestone (adapting the figures, editing the video).
- `counterfactual` — what the receiving line would spend or lack without it; `hoursSaved` is that cost in hours (0 when what it lacks is not time).

```json
{"from": "research-figures", "toLine": "media", "toMilestone": "", "use": "作为科普视频第 2 期的讲解配图",
 "transfer": {"metric": "图表", "expected": 3, "unit": "张"}, "lagDays": 3,
 "counterfactual": "创作者线自己重画 3 张示意图约需 6 小时，且没有真实仿真数据", "hoursSaved": 6}
```

| | counterfactual |
|---|---|
| 好 | 「自己重画要多花约 6 小时」「拿不到真实测量数据，视频只能用示意图」 |
| 坏 | 「会更难」「效果会差一些」「互相促进」 |

**Few and real.** Each line feeds **at most two** pairs; more are cut in code, ranked by `hoursSaved`, then `expected`. Goals that feed each other help only a little, a task tied to many goals reads as less useful for each, and coordinating costs time. So a pair is an artifact dependency someone can check on a date: did the 3 figures reach the video or not. 「提升影响力」「积累经验」 are not pairs. No pair for a line is a valid answer when nothing transfers.

**Timing is checked in code.** The producing milestone is due no later than the receiving milestone's deadline minus `lagDays`. When two lines supply each other (media sends questions back to research), every leg needs at least a day and the return leg lands on a **later** milestone of the line it returns to, never the one that started the loop. Choose `readyBy` and `lagDays` so this can hold.

`assumptions` names what was assumed (a thin profile, a line with no clear product). `blockers` only when nothing at all can be planned for any planned line.

## Personal preferences

When facts or feedback say the person turned a link down, do not propose it again in other words.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线, 飞轮关系, 产出; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.

Allowed tools: none. Budget: premium. Risk: milestone.
