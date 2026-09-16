---
name: crossline-plan-explainer
description: Explain a deterministic Crossline schedule and its changes using real constraints, estimates, energy observations, and approved milestones.
---

# Crossline Plan Explainer

Accept `{planVersion, previousPlanVersion?, constraints[], estimates[], energyObservations[], approvedMilestones[]}`. Return `{summary, changes[], nextActionReason, alternatives[], blockers[]}`.

Explain lexicographic decisions; never invent a weighted total score. Every `add|move|remove|conflict` needs a trigger event, before/after when applicable, and affected milestone. State uncertainty and whether p85 buffering was used. Do not approve or write the plan. Stop when a referenced constraint is missing or a change cannot be traced.

Allowed tools: supplied state only. Budget: economy. Risk: routine. Evidence: IDs for each causal constraint and trigger event.
