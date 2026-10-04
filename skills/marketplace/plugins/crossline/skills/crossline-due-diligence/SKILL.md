---
name: crossline-due-diligence
description: Research a question the person's own profile raises on the public web and report sourced findings and proposals, before anything is proposed as a goal or a task.
---

# Crossline Due Diligence

Accept `{version: "crossline.diligence.v1", today, timeZone, identity, topic, projects[], facts[], constraints[], alreadyDecided[]}`. Return exactly `{question, sources[], findings[], proposals[], gaps[], blockers[]}` as raw JSON, with no code fence and no prose around it.

This Skill exists because the person's own aims are often vague ("find suitable competitions", "work out my positioning") and the right response is to find out what is true first, report it, and only then suggest something. Requirements that came from other people (an advisor's task, a course deadline) are not researched; they are fixed.

## sources[]

`{id, url, title, publisher, accessedOn}`. A source is a **public https page you opened**: `title` is the page's real title, `accessedOn` the date you read it (today, or within three days). A literal IP address, a local or intranet name, or a URL with a port is refused. The app opens every source after you answer; one that does not resolve, or whose content does not match the title you gave, is dropped together with every finding that depended only on it, so citing a page you did not read can only make the report smaller.

## findings[]

`{id, claim, sourceIds[], confidence, staleWhen}`. A claim is one checkable statement taken from what you read: a condition, a date, a number, a rule. Say `staleWhen` — the event that would make it no longer true (the next cycle opening, a rule change). Never state a deadline, price, requirement or figure the source does not give. Confidence is how directly the source states it, not how plausible it sounds.

## proposals[]

`{id, title, why, kind, dueDate, basedOnFacts[], findingIds[]}`. A proposal follows from at least one finding **and** from the person's own facts: `basedOnFacts` holds fact ids copied from `facts[]`. `kind` is `milestone` (a state worth reaching), `task` (one thing to do), or `watch` (something to check again later). `dueDate` is a `YYYY-MM-DD` from a source, or empty. Respect every line in `constraints[]`: an opportunity that ignores one is not useful however real it is. Do not repeat anything in `alreadyDecided[]`, accepted or rejected.

## What to research, by `topic.kind`

- `opportunities` — external routes (competitions, incubators, grants, partners) the person can actually use at their stage and status, with eligibility and deadline for each.
- `positioning` — what the public evidence says about audience, platform rules and comparable accounts or cases; propose a positioning and a first run of topics, each tied to a finding.
- `literature` — the most relevant papers and groups for the person's projects, a reading list they can start on, and the gaps nobody has filled.
- `tracking_framework` — metrics, definitions, cadence and data sources for tracking return and risk, and a memo template. **No buy or sell call, no price target, no personalised allocation advice**, in findings or proposals. Findings and frameworks only.

## Boundaries

Do not create goals, tasks or schedule entries: everything lands as a pending proposal the person accepts or rejects. Do not contact anyone, sign up for anything, or submit anything. Put what you could not establish in `gaps[]` rather than guessing; an honest short report is better than a long one with invented detail. Write every human-readable field in Chinese.

Allowed tools: web research. Budget: mid tier. Risk: milestone.
