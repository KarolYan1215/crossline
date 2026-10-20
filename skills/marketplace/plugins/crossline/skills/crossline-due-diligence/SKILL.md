---
name: crossline-due-diligence
description: Research a question the person's own profile raises on the public web and report sourced findings and proposals, before anything is proposed as a goal or a task.
---

# Crossline Due Diligence

The person's own aims are often vague (「找合适的比赛」「想清楚定位」), so the right response is to find out what is true first, report it, and only then suggest something. Your report becomes a research card: the findings with their sources, and the proposals the person decides one by one in the weekly review (采纳 or 不要). An accepted `task` goes into their inbox and is planned like anything they type; an accepted `milestone` is given to the milestone design for this line. Requirements that came from other people (an advisor's task, a course deadline) are not researched; they are fixed.

Accept `{version: "crossline.diligence.v1", today, timeZone, identity, topic, projects[], facts[], constraints[], alreadyDecided[]}`:

- `identity`: the line (`id`, `label`, and `noTradeCalls: true` for the investment line and any wealth line). `topic`: `kind` and `question`, what to research for this line.
- `projects`: the line's projects (`id`, `name`, `summary`).
- `facts`: what is on record about this line and about the person (`id`, `projectId`, `slot`, `value`, `status`). The person's own status, place and stage are here: read them before deciding what applies. A fact with `status: "inferred"` is the interviewer's guess, not the person's word.
- `constraints`: limits the person stated. `alreadyDecided`: proposals the person already accepted or rejected.

Return exactly `{question, sources[], findings[], proposals[], gaps[], blockers[]}` as raw JSON, with no code fence and no prose around it.

## question

What you actually researched, in one plain line, fitted to this person: 「杭州早期创业者今年可申请的孵化器与创业比赛」, not the instruction text of `topic.question`.

## sources[]

`{id, url, title, publisher, accessedOn}`. A source is a **public https page you opened**: `title` is the page's real title, `accessedOn` the date you read it (today, or within three days). A literal IP address, a local or intranet name, or a URL with a port is refused. The app opens every source after you answer; one that does not open, or whose content does not match its title, is dropped together with every finding that rested only on it.

## findings[]

`{id, claim, sourceIds[], confidence, staleWhen}`. A claim is one checkable statement from what you read: a condition, a date, a number, a rule. Write names (programmes, organisations, products) as the cited page writes them: the app checks that the Latin names in a claim appear on the page it cites, and drops the citation when they do not. `staleWhen`: the event that would make it no longer true (the next cycle opening, a rule change). Never state a deadline, price, requirement or figure the source does not give. `confidence` (`high`, `medium`, `low`) is how directly the source states it, not how plausible it sounds.

- Good (the shape, not a fact): 「某省创业大赛 2026 年报名截止 11 月 15 日，参赛者须为在读学生或毕业 5 年内」 (one rule, one date, from the organiser's own notice).
- Bad: 「各类创业比赛门槛不高，适合尽早参加」 (no condition, no date, nothing to check).

## proposals[]

`{id, title, why, kind, dueDate, basedOnFacts[], findingIds[]}`. A proposal follows from at least one finding **and** from the person's own facts: `basedOnFacts` holds fact ids copied from `facts[]`, preferring the person's confirmed facts over guesses. `dueDate` is a `YYYY-MM-DD` from a source, or empty.

- `kind` `task`: one thing to do; `title` reads as a to-do line, verb first, with the day: 「11/15 前提交 某省创业大赛 报名表」.
- `kind` `milestone`: a result worth reaching, stated as an event, not a state: 「12 月前拿到一家孵化器的入驻答复」, not 「提升创业能力」.
- `kind` `watch`: something to check again later: 「2027 年春季批次开放时核对申请条件」.
- `why`: in one or two sentences, which finding and which of the person's facts make it fit.

Respect every line in `constraints[]`: an opportunity that ignores one is not useful however real it is. Do not repeat anything in `alreadyDecided[]`, accepted or rejected.

## What to research, by `topic.kind`

- `opportunities`: external routes (competitions, incubators, grants, partners) this person can actually use. Take their status, place and stage from `facts`; assume none. A Hangzhou founder who is not a student is not offered a US university's student fund. List eligibility and deadline for each; a condition `facts` cannot settle goes in `gaps`.
- `positioning`: what the public evidence says about audience, platform rules and comparable accounts or cases; propose a positioning and a first run of topics, each tied to a finding.
- `literature`: the most relevant papers and groups for the person's projects, a reading list they can start on, and the gaps nobody has filled.
- `tracking_framework`: metrics, definitions, cadence and data sources for tracking return and risk, and a memo template; for a wealth line also the household basics the person asked about (an emergency fund, a savings rate, paying down a debt, a bookkeeping routine). **No buy or sell call, no price target, no personalised allocation advice**, in findings or proposals, whenever `identity.noTradeCalls` is true.
- `evidence_summary` (a wellness line): what clinical guidelines and systematic reviews say about the person's own goal (exercise frequency and intensity, sleep, diet), with how strong the evidence is. Every injury, condition or doctor's instruction in `facts` is a limit to respect. **No diagnosis, no medication or dose, nothing that replaces a doctor's advice**; a question only a doctor can answer goes in `gaps`.

## Boundaries

Do not create goals, tasks or schedule entries: everything lands as a pending proposal the person accepts or rejects. Do not contact anyone, sign up for anything, or submit anything. Put what you could not establish in `gaps[]` rather than guessing; an honest short report beats a long one with invented detail. `blockers`: only when you cannot research at all.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
