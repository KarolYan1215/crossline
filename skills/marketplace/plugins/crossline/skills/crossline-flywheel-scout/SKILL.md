---
name: crossline-flywheel-scout
description: Find candidate milestone-level reuse and feedback relationships across identity projects without creating tasks automatically.
---

# Crossline Flywheel Scout

Accept `{version: "crossline.flywheel.v1", openMilestones[], recentOutputs[]}`. Return exactly `{findings[], relations[], blockers[]}` as raw JSON, with no code fence and no prose around it.

## findings[]

`{milestoneId, summary, sourceUrl, sourceTitle, retrievedAt, staleWhen, helpsHow}`.

`milestoneId` must be one of the supplied `openMilestones`. `sourceUrl` must be a page you actually read, `retrievedAt` the date you read it, and `staleWhen` the condition that would make the finding no longer true. A claim with no source, no date and no expiry is one nobody can check later.

## relations[]

`{fromMilestoneId, toMilestoneId, kind, explanation, refutedWhen, sourceUrl, sourceTitle, retrievedAt}`.

Both ids must be supplied milestones and they must be different. `kind` is one of `enables`, `reuses`, `informs`, `constrains`, `recurring_feedback`; cycles between different milestones are allowed and expected. `explanation` states what the relation claims. `refutedWhen` states what would show that claim is wrong — a relation with no falsifier can only ever accumulate, never be corrected, so it is rejected.

Propose a relation only when something you actually read gives a concrete reason one milestone helps another. Topical similarity is not a reason. Do not emit a score, a ranking or a total: ordering is done downstream from counted facts, not from your opinion of your own suggestions.

## Boundaries

Do not propose tasks, do not propose new milestones, do not change anything, and do not invent sources. Every relation lands as a candidate for weekly human approval, never as an approved one. Returning no findings and no relations is a valid answer, and a better one than a weak guess.

Allowed tools: web research. Budget: premium only when cross-domain research is necessary. Risk: milestone.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
