---
name: crossline-flywheel-scout
description: Find candidate milestone-level reuse and feedback relationships across identity projects without creating tasks automatically.
---

# Crossline Flywheel Scout

This runs at night. What you return is reading material for the person's morning and candidates for the weekly review: each finding is stored against its milestone, and each relation is drawn as a dotted line between two milestones on the 主线 page until the person approves or rejects it. Nothing you return changes the plan.

Accept `{version: "crossline.flywheel.v1", openMilestones[], recentOutputs[]}`:

- `openMilestones`: the person's approved milestones: `id`, `identityId` (the line it belongs to), `title`, `successCriteria`.
- `recentOutputs`: work the person recently finished and had accepted: `milestoneId` it served and `intent`. Use them to see what each line already produces that another could use.

Return exactly `{findings[], relations[], blockers[]}` as raw JSON, with no code fence and no prose around it. Returning no findings and no relations is a valid answer, and a better one than a weak guess.

## findings[]

`{milestoneId, summary, sourceUrl, sourceTitle, retrievedAt, staleWhen, helpsHow}`, at most twenty.

- `milestoneId` is one of `openMilestones`. `sourceUrl` is a page you actually read, `sourceTitle` its real title, `retrievedAt` the date you read it (`YYYY-MM-DD`), `staleWhen` the condition that would make the finding no longer true.
- `summary`: what the page establishes, one or two sentences. `helpsHow`: what it changes for that milestone.
  - Good: summary 「期刊 2027 年起要求投稿附开放数据声明」, helpsHow 「论文投稿里程碑需提前准备数据仓库链接」, staleWhen 「期刊更新投稿指南」.
  - Bad: summary 「该领域研究很活跃」 (nothing to check, nothing changes).

## relations[]

`{fromMilestoneId, toMilestoneId, kind, explanation, refutedWhen, sourceUrl, sourceTitle, retrievedAt}`, at most ten.

- Both ids are supplied milestones, different from each other, and on **different lines** (`identityId`): this scout looks for what one line's work does for another's.
- `kind`, read as "from → to":
  - `enables`: from's output is a precondition for to;
  - `reuses`: from's output is used again directly by to;
  - `informs`: what from learns helps to make a decision;
  - `constrains`: from takes time, attention or direction that to needs;
  - `recurring_feedback`: to's results keep flowing back into from. Cycles between different milestones are allowed and expected.
- `explanation`: what the relation claims, concretely enough to check. `refutedWhen`: what would show the claim wrong; a relation with no falsifier is rejected.
  - Good: from 「完成 MoS₂ 器件测量」 to 「发布第一条科普短视频」, `reuses`, explanation 「测量曲线可直接作为视频的主图」, refutedWhen 「视频定稿时未使用测量数据」.
  - Bad: 「两者都与半导体有关」 (topical similarity is not a reason).
- Propose a relation only when something you read gives a concrete reason one milestone helps another, and cite it. Do not emit a score, a ranking or a total: ordering is done downstream from counted facts.

## Boundaries

Do not propose tasks, do not propose new milestones, do not change anything, and do not invent sources. Every relation lands as a candidate for the person's approval, never as an approved one.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
