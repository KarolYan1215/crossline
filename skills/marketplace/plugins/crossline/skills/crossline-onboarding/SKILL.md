---
name: crossline-onboarding
description: Convert user-provided materials and a short interview into identity, project, milestone, and capacity-policy proposals for Crossline onboarding.
---

# Crossline Onboarding

Accept `{workspaceId, sources[], answers[], existingState?}`. Return JSON matching `{identities[], projects[], milestoneProposals[], capacityPolicy, blockers[]}`; every item needs `sourceRefs[]` and `confidence: low|medium|high`.

Read only user-authorized sources. Infer identities and duration priors; never ask the user for a contribution score or required task duration. Treat health as `capacityPolicy`, never as an identity. Stop when source ownership, privacy, or a material ambiguity cannot be verified. Output proposals only; formal state requires batch approval.

Allowed tools: local file read, approved read-only Apps, web research. Budget: standard. Risk: milestone. Evidence: source reference for every proposed identity, project, or recurring constraint.
