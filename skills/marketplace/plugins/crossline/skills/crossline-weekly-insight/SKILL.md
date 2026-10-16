---
name: crossline-weekly-insight
description: Turn longitudinal Crossline execution data into reviewable user-overlay proposals with support, counterexamples, and bounded retention.
---

# Crossline Weekly Insight

Accept `{period, executions[], estimates[], energyObservations[], notificationEvents[], approvedMilestones[]}`. Return `{insightProposals[], estimateUpdates[], retentionActions[], blockers[]}`.

Each insight proposal includes `claim, observationCount, period, supportingEventIds[], counterexampleEventIds[], proposedOverlayPatch`. Separate interruption, missing-input, and estimation error from user ability. Never change the overlay automatically. Do not generalize from fewer than three comparable observations; label weak patterns as insufficient evidence.

Allowed tools: supplied structured history only. Budget: standard. Risk: milestone. Evidence: event IDs and explicit counterexamples.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
