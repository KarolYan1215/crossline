---
name: crossline-weekly-insight
description: Turn longitudinal Crossline execution data into reviewable user-overlay proposals with support, counterexamples, and bounded retention.
---

# Crossline Weekly Insight

Accept `{period, executions[], estimates[], energyObservations[], notificationEvents[], planChanges[], approvedMilestones[]}`. Return `{insightProposals[], estimateUpdates[], retentionActions[], blockers[]}`.

Each insight proposal includes `claim, observationCount, period, supportingEventIds[], counterexampleEventIds[], proposedOverlayPatch`. Separate interruption, missing-input, and estimation error from user ability. Never change the overlay automatically. Do not generalize from fewer than three comparable observations; label weak patterns as insufficient evidence.

Allowed tools: supplied structured history only. Budget: standard. Risk: milestone. Evidence: event IDs and explicit counterexamples.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
