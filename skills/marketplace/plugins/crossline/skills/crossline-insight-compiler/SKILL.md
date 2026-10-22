---
name: crossline-insight-compiler
description: Compile the person's own skill for one line — how this person does this line's work (plays, preferences, hard red lines) — from what they said and decided, every rule tied to its source.
---

# Crossline insight compiler

The input (`crossline.mine-skill.v2`) is one line (`line`: `id`, `label`, `goals`), the materials about it (`materials`, each with an `id` such as `m3f9a21`, a `kind`, the `text`, a `label` saying where it came from and its date `at`), the rules of the version in use (`previousRules`, each `{id: "r1", kind, text, sources, quote, url}`) and `today`. When there are previous rules, `materials` holds only what is **new or changed** since they were compiled; the materials behind them are not shown again, and their `quote` is the words they rest on. Return only the requested strict JSON object: a short `summary`, the `rules` (your changes, below), and `blockers` (empty unless nothing at all can be written).

## Changes, not a rewrite

Each item of `rules` is one change, with `op` and `ruleId`:

- `add` (`ruleId` ""): a new rule, every field filled as below.
- `revise` (`ruleId` of a previous rule): the rule rewritten — a new material refines, narrows or contradicts part of it. Fill every field; it may keep the previous rule's `sources` and `quote` or cite a new material.
- `drop` (`ruleId`): a new material plainly reverses the rule (the person said the opposite since). Other fields may be empty.
- `keep` (`ruleId`): the same as not naming it; only use it when it helps to say so. Other fields may be empty.

A previous rule you do not name stays exactly as it is, so name only what the new materials bear on. Nothing in the new materials about how the work is done (only a new scheduling fact, say) means no changes at all: return an empty `rules` and no blocker. A rule may cite the ids in `materials` and the `sources` of any previous rule. `summary`: with previous rules, leave it "" unless the changes alter it. Crossline renders the skill's SKILL.md from your rules, each with its source and quote, and the person reads and can edit it in Settings → Skill 库.

What the skill is for: other runs — the assistant doing a task on this line, the step planner, the tutorial writer, the acceptance gate — read it to do the work **the way this person does it**. It replaces nothing they already know about the craft; it records what is particular to this person. On 2026-10-14 the assistant wrote a Xiaohongshu note as a cautious research report because the person's play — 「制造冲突、贩卖焦虑，再卖 solution」 — was written down nowhere. That kind of statement is exactly what belongs here.

## Materials

- `review`: the person's note when accepting or returning the assistant's result. The strongest signal: it says what was wrong with real work.
- `preference`: a correction the person gave, a milestone retrospective, a standard they confirmed, a cross-line link they turned down.
- `gate`: the acceptance gate found a delivery covered its task but went against this skill; the text names the broken rules.
- `edit`: the person wrote or changed this skill by hand. Every rule in it is the person's own and stays, unless a newer material plainly reverses it.
- `fact`: something confirmed in the interview about this line (audience, platform, goals, constraints, way of working).

## Rules

Each rule has a `kind`:

- `play` — how the person goes about this line's work: the structure, angle, tone, sequence or bar they use (「开头先抛出冲突或焦虑点，结尾给出可购买的 solution」).
- `preference` — a narrower like or dislike (「不写成科研报告体，不堆免责声明」).
- `redline` — something that gets the work punished or removed: a platform's hard rule, a legal limit, a line the person said never to cross. Only hard limits, never taste.

Write each rule as one instruction another run can follow and check against a finished piece, in the person's terms.

- Good `play`: 「标题与开头先抛出读者的焦虑点或冲突，正文给解释，结尾给出可购买的 solution」, quote 「制造冲突、贩卖焦虑，再卖 solution」.
- Good `preference`: 「不写成科研报告体，不堆免责声明」, quote from the person's review note 「太像论文了，免责声明删掉」.
- Bad: 「内容要有价值、结构清晰」 (generic, nobody's in particular), or a rule whose quote is the compiler's paraphrase rather than words in the material.

Then:

- `sources`: the ids of the materials it rests on (one or more). A rule no material supports is not written.
- `quote`: copied verbatim from one of those materials — the words that show the rule is the person's (punctuation may differ; words may not).
- `url`: empty, except for a platform red line that rests on the platform's own published rules rather than on a material: then `sources` is empty, `url` is the public https page you found with web search, and `quote` is the rule's wording on that page. Prefer the platform's own community rules page. Add such a red line only where the person's play goes near it — a play built on conflict and anxiety, for example, sits next to rules against inciting antagonism between groups (gender, region and the like); the red line says where the edge is so the play can stay just inside it.

When the person's play conflicts with a platform's usual style or with generic best practice, the person's play wins: write it as they said it. Only a red line limits it.

Leave a previous rule alone while nothing new reverses it; drop it when a newer material does; revise it into one rule when a new material says the same thing more precisely, instead of adding a second. Write no generic methodology (「结构清晰」「注意数据准确」) unless the person said it about their own work. No more than about fifteen rules; fewer is fine.

`summary`: two or three sentences on how this person approaches this line, drawn from the rules.

If there are no previous rules and the materials say nothing about how the person does this line's work (only scheduling facts, say), return no rules and one blocker with code `MINE_SKILL_NOTHING_TO_SAY` explaining what is missing.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
