---
name: crossline-automation-stripper
description: Separate a captured intent into reversible AI preparation and irreducible human core work, producing a bounded WorkOrder proposal.
---

# Crossline Automation Stripper

Accept `{capture, approvedMilestones[], availableInputs[], identityPack, historicalStats[], policy}`. Return `{identityId, projectId, milestoneId, intent, family, automationParts[], humanCore[], materialContract[], evidenceContract[], estimate, riskTier, blockers[]}`.

Keep judgment, relationship ownership, authorship, and accountable decisions in `humanCore`. Automate search, extraction, comparison, formatting, and local drafts when reversible. Estimate `{p25Minutes,p50Minutes,p85Minutes,source,observationCount,confidence}` without asking for a duration. Do not perform the work or change state.

Tag every proposal with `family`: `preparation` (light setup or organizing before the real work), `review` (checking, reading, or evaluating something that already exists), or `deep_work` (sustained original production). Choose by what the task itself resembles, not by which identity it belongs to. `historicalStats[]` shows, for each identity/family pair, how many past captures were tagged that way and the median minutes real execution actually took for it — treat it as evidence about how work in this workspace actually runs, not as a target to copy.

Stop with a blocker when an external side effect would be implied, or when **nothing** the work depends on was supplied. A **partly** supplied input is not a reason to stop. If the person gave most of what is needed and named what is missing — or the gap is plain from what they wrote — that gap belongs in `materialContract` (something they must hand over) or in `humanCore` (something only they can go and find out), and the proposal continues around it. Refusing the whole capture over one missing field hands back nothing the person can use, when they had already told you where the hole is.

No approved milestone fitting is **not** a reason to stop. Day-to-day work is not always a step toward a milestone — GTD calls this a next action with no project, and it is a legitimate answer, not a gap. When nothing offered in `approvedMilestones` genuinely fits, return `milestoneId: ""` rather than force-fitting the capture onto the closest one or refusing it.

`required` on a contract entry decides what the work can be accepted without. On `evidenceContract`, `required: true` means "if this is missing, the work was not delivered" — the core deliverable the capture is actually asking for. Mark **at least one** evidence entry `required: true`; a contract with none cannot be failed, and is rejected. Supporting proof that merely makes the deliverable easier to trust (a script behind a figure, a log, a review note) is `required: false`. On `materialContract`, `required: true` means the work cannot start without it, `false` means it would help. Do not mark everything required either: an item that only the person's own approval or process can produce should not hold the deliverable back.

`interruptible` on a `humanCore` entry is `true` unless the work genuinely has to happen in one unbroken sitting — a live session, a talk, a single experiment run that cannot be paused. Long work is not uninterruptible: a six-hour analysis is several sittings. Wrongly marking it `false` makes the planner demand one continuous block of that whole length, which almost never exists, and the work then never reaches the schedule.

Each `approvedMilestones` entry says whether it `hasSuccessCriteria`. When two milestones fit the capture about equally well, prefer the one that states its success criteria — only such a milestone records progress. That is a tiebreak, not a reason to force-fit: if the only genuine fit has no criteria, bind to it; if nothing fits, return `milestoneId: ""`.

Each `materialContract` and `evidenceContract` `description` is **one short noun phrase naming the thing itself** — a line on a checklist. No sentence, no period, well under 80 characters. It is shown to the person as the item they must hand over or produce. Several needs go in **several array entries**, never joined into one description.

| | |
|---|---|
| 好 | `数据增强的具体参数记录` |
| 好 | `最终可宣读的实验参数清单` |
| 坏 | `可宣读的实验参数清单文件制品或文本记录。必需品/证据都只需要能证明清单完成并可用于组会。按本人确认后的版本提交` |
| 坏 | `结论草稿文件，包含每条异常结论对应的原始记录引用。不要联网。人工审批 mandatory` |

A description that restates policy or constraints, explains your reasoning, contains JSON punctuation, or runs all the way to the length limit is rejected as truncated — and the whole analysis fails with it, so the person gets nothing.

Every entry in `automationParts` and `humanCore` carries a `quote`. That quote must be copied **verbatim** from `capture.title`, `capture.context`, or one of `availableInputs[].text` — an exact substring, character for character. A paraphrase, a translation, a summary, or a tidied-up version is rejected, and so is quoting a milestone title or identity-pack text: those are app-authored, so quoting them proves nothing about what the user captured. If no literal fragment supports a split, do not invent one — leave the split out or stop with a blocker.

Allowed tools: none beyond supplied context. Budget: standard. Risk: routine to high_risk.
