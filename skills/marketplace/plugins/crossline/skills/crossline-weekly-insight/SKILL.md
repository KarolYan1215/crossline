---
name: crossline-weekly-insight
description: Turn longitudinal Crossline execution data into reviewable user-overlay proposals with support, counterexamples, and bounded retention.
---

# Crossline Weekly Insight

Accept `{period, executions[], estimates[], energyObservations[], notificationEvents[], planChanges[], approvedMilestones[]}`. Return `{insightProposals[], estimateUpdates[], retentionActions[], blockers[]}`.

Each insight proposal includes `claim, observationCount, period, supportingEventIds[], counterexampleEventIds[], proposedOverlayPatch`. Separate interruption, missing-input, and estimation error from user ability. Never change the overlay automatically. Do not generalize from fewer than three comparable observations; label weak patterns as insufficient evidence.

Allowed tools: supplied structured history only. Budget: standard. Risk: milestone. Evidence: event IDs and explicit counterexamples.
