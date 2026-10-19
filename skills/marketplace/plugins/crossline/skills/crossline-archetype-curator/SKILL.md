---
name: crossline-archetype-curator
description: Propose at most three new task archetypes for work this person repeats that no existing archetype fits, built from the fixed primitives and roles and grounded in a public standard.
---

# Crossline Archetype Curator

An archetype is the grammar the step planner uses to split a kind of task into steps: its roles, the few ordering rules that make it that kind of work, the usual share of time per role, a size formula and an acceptance standard. Eighteen are built in. You add one only where this person keeps doing work the built-in ones fit badly; the step planner is then offered it beside them, and the person can retire it in Settings.

Input is `crossline.archetype-curation.v1`:

- `builtin` and `learned`: the existing archetypes, each `{id, label, primitives, roles, requires, firstBefore, endsWith, proportions, quantify, acceptance, tickHint, agentRoles}`.
- `tasks`: the person's recent planned tasks: `id`, `intent`, `line`, `archetypeId` (the one it was given) and `roles` (its steps' roles, in order).
- `preferences`: what the person corrected or showed about how they work.

Return raw JSON only: `{archetypes, notes}`.

## When to propose

- Only for work that recurs in `tasks` (at least two task ids) and that its archetype fits poorly: the steps had to be bent (roles in an order its rules forbid, roles it does not have, sizes far off its formula), or `preferences` say the classification or order is wrong.
  - Example: three 「剪辑周 vlog」 tasks were given `content`, which requires `draft` and `publish`, and each was planned as `gather → build → revise → check` with no draft and the publishing left to the person outside the plan, at about twice the formula's minutes: a 「短视频剪辑」 archetype with those roles is worth proposing.
  - Not: one task that fit oddly, or a renamed copy of an existing archetype.
- Returning `[]` is the normal answer when the existing ones suffice; say why in `notes` (「近 40 个任务都落在已有原型内，没有反复出现的偏差」).

## Each archetype

- `id`: a new slug of lowercase letters and underscores only, 3 to 31 characters, no digits (`short_video_edit`). `label`: a short Chinese name (「短视频剪辑」).
- `primitives` and `roles` only from the sets the built-in archetypes use, at least two roles. `requires`, `firstBefore` (pairs of roles), `endsWith` and `agentRoles` name only its own roles. Keep rules few: an archetype is a grammar, not a fixed sequence.
- `proportions`: each role's usual share of the time (shares above 0, together about 1). `quantify`: `basis` and `unit` (「成片分钟数」「分钟」) and `minutesLow`/`minutesHigh` per unit, worked from the tasks' real sizes.
- `acceptance`: a recognised standard for the result (「成片符合平台竖屏规格，响度约 −14 LUFS，字幕与口播一致」). `tickHint`: how a near-term result is phrased, as a capability or an artefact (「导出一条 60 秒竖版成片」).
- `recurring`: true when the work comes back on a fixed rhythm (every week, every issue).
- `basedOnTaskIds`: the task ids it is drawn from (at least two of `tasks`). `sources`: at least one public standard, guideline or method page found with web search (`https` URL and its real title); the worker opens it and drops the archetype if none opens. `why`: one sentence on what the existing archetypes got wrong for these tasks.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
