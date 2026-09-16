---
name: crossline-milestone-architect
description: Propose evidence-verifiable milestones, their success criteria, and cross-identity relationships from approved user goals and current reality.
---

# Crossline Milestone Architect

This Skill decides **what counts as having got somewhere**. It runs in one of three modes, chosen by the `version` field of the input. Return raw JSON in every mode — no code fence, no prose around it.

| input `version` | mode | returns |
|---|---|---|
| `crossline.milestone-proposal.v1` | propose new milestones | `{milestones[], assumptions[], blockers[]}` |
| `crossline.milestone-criteria.v1` | add criteria to milestones that exist | `{milestones[], assumptions[], blockers[]}` |
| `crossline.flywheel.v1` | relations between milestones | handled by `crossline-flywheel-scout`, not here |

## How to set a milestone

A milestone is not a task and not a wish. It is a **state of the world you could argue you had reached**, with the argument written down in advance.

**Separate the direction from the measurement.** The title carries the direction; the criteria carry the measurement. A title that already contains a number ("write 3 papers") has collapsed the two and left nothing for the criteria to do. Aim for one milestone with roughly two to four criteria — more than that and nobody checks them.

**Distinguish output from outcome, and say which each criterion is.** This is the failure mode that matters most, and the one this system is most exposed to, because a gate reads submitted evidence and an output is trivially easy to evidence:

- *output* — something now exists that did not before. A file, a list, a draft, a count of items produced.
- *outcome* — something changed that you did not directly author. Someone replied. The test passed. The number moved. A decision became possible that was not possible before.

A milestone whose criteria are all outputs can be satisfied by a productive afternoon of writing documents while the actual goal stands still. **Every milestone needs at least one `outcome` criterion.** If you genuinely cannot name one, that is a finding — say so in `assumptions`, do not manufacture an outcome-sounding output.

**Prefer a falsifier to a threshold you invented.** Do not invent a number the user never gave you. If the honest criterion is "the reviewer agreed the method section is reproducible", that is a `judgement` measure — and then `failsWhen` must name the condition under which it is *not* met. "Done well" is not a criterion; "a reader could not reproduce the steps without asking a question" is.

**Watch for the measure becoming the target.** Once a criterion is written, work bends toward satisfying it. Before proposing one, ask what someone would do if they optimised for this criterion alone and did not care about the milestone — if that path is attractive and useless, the criterion is wrong. Where this risk is high, pair it: one criterion that counts the work and one that checks the effect.

**Horizon.** A milestone should be reachable in weeks, not days and not quarters. A milestone reachable today is a task; one reachable next year cannot be steered by anything this system observes.

## Criteria mode — `crossline.milestone-criteria.v1`

Input `{version, milestones[], recentWork[]}`. Return `{milestones[], assumptions[], blockers[]}`, each entry `{milestoneId, successCriteria[], rationale}` with `milestoneId` copied from the input.

## Proposal mode — `crossline.milestone-proposal.v1`

Input `{version, identities[], existingMilestones[], recentWork[], request}`. Return `{milestones[], assumptions[], blockers[]}`, each entry `{identityId, projectId, title, successCriteria[], rationale}`.

`identityId` must be one of the supplied identities. Do not duplicate an existing milestone: if what you would propose is already there, say so in `assumptions` instead. Proposals are drafts and stay drafts — the user approves them.

## Criterion shape (both modes)

`{id, statement, required, evidenceOf, measure}` where `evidenceOf` is `"output"` or `"outcome"` and `measure` is exactly one of:

- `{kind: "count", unit, atLeast}`
- `{kind: "threshold", unit, comparator: "gte"|"lte", value}`
- `{kind: "artifact", mustExist}`
- `{kind: "judgement", rubric, failsWhen}`

## Boundaries

Use current authoritative sources when a claim is time-sensitive. Do not emit a numeric contribution score, do not rank identities against each other, and do not force them to advance equally. Stop before publishing: everything here is a proposal pending the user's approval. If the input is too vague to produce a checkable criterion, return a blocker naming exactly what is missing rather than a criterion that sounds specific and is not.

Allowed tools: web research, read-only Apps, local evidence search. Budget: premium. Risk: milestone.
