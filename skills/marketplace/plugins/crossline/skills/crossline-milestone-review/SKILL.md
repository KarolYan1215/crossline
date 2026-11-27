---
name: crossline-milestone-review
description: A critical read of milestones: what could keep each drafted milestone from being reached and how much it weighs (`risk`), and whether a newly approved one may open now, should wait, or is not worth doing (`admission`, gate J4). The input's `mode` says which.
---

# Crossline milestone review

A critical read of milestones: what could keep each drafted milestone from being reached and how much it weighs (`risk`), and whether a newly approved one may open now, should wait, or is not worth doing (`admission`, gate J4).

Every run's input carries `mode`: `risk` (Risks and weights of drafted milestones), `admission` (Admission of a newly approved milestone). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "risk"` — Risks and weights of drafted milestones

Read Crossline milestones critically, mostly as they are drafted, and name, for each, what could keep it from being reached on its date — too little time, too little working time, a prerequisite not ready, a result set too high, a standard that cannot be judged — as a level, a kind and one short note; also weigh each milestone (0–100) and say whether it is a sitting held at a set time. A milestone may have no risk.

The milestone architect has just drafted milestones for the person's lines. Before the person approves them, this Skill reads them as a sceptical reviewer would: not whether they are well written, but whether they can be reached as drafted. Who reads the answer:

- the person, on the 主线 page: each risk is a glyph and a short tag on the marker, and 一键批准 shows all the drafts' risks together before approving;
- the person again, for an approved milestone with a `medium` or `high` risk: it is asked about on 待决事项 (接受，按风险提前安排 / 调整截止 / 降低标准 / 不用管). Only once they accept it does the scheduler aim that milestone's work a day or two early. An `unclear` risk moves nothing.

Nothing is blocked by a risk. The note is the whole explanation the person gets, so it must say what the risk rests on.

### Input `crossline.milestone-risk.v2`

- `today`; `weeklyHours` — hours a week for all lines together (null when unknown).
- `milestones` — the milestones to review, mostly new drafts and sometimes approved ones never reviewed (`status`): `id`, `line`/`lineLabel`, `project`, `title`, `deadline` (null when undated), `daysLeft`, `criteria` (the standards as written), `rationale` (the architect's reasoning and back-calculation), `dependsOn` (earlier milestones of the same chain it waits on, with dates) and `ruleFindings` (`{level, kind, note}` the app's deterministic checks already found from dates, dependencies, score margins and deadline clusters).
- Per milestone, for the weight and the sitting: `standing` (`{rank, hard}`: the line's place in the person's 12–24 month order, rank 1 = the base line, null = in parallel; `hard` = a hard-constraint line), `relations` (cross-line relations through it), `graded` (its project counts toward a grade the person stated), `pastAdjustments` (the person's past slider moves on this line: their weight minus the preset at the time) and `sameDayEvents` (`{start, end, title}`: fixed events on its deadline day — classes, synced events, the exam itself).
- `others` — every other live milestone (any line, approved or draft) with its date and line, so the review sees what competes for the same weeks.

Return raw JSON only: `{milestones: [{milestoneId, risks: [{level, kind, note}], weight, weightWhy, sitting, startsAt}]}`, exactly one entry per milestone given, `milestoneId` copied exactly. `risks: []` is a real answer: a milestone with nothing worth naming has no risk.

### Weight and sitting

The app no longer scores these with rules; your answer is the preset the person sees and moves.

- `weight` — 0–100, how much this milestone matters against the person's other milestones: the preset of its importance slider, and at 60 or more its tasks are important (researched first, scheduled ahead of ordinary work). Weigh the line's standing (a hard constraint or the base line high, a parallel line in the middle), the relations through it (others build on it), what is at stake (a grade, an external decision, a date that will not move, how soon) and the person's own past moves on the line (they keep lowering it: lower; raising it: higher). 50 is ordinary.
- `weightWhy` — one short clause naming what the weight rests on (「硬约束主线，计入课程成绩，三周后截止」), no advice.
- `sitting` — `true` when the milestone is itself an event held at a set time — an exam, a quiz, a defence, a talk or a presentation — so preparing for it is useless once it has begun and over once its day has passed; `false` for a result reached by work (a submission, a draft, a figure).
- `startsAt` — for a sitting, the time it starts on its deadline day as `HH:MM`, read from `sameDayEvents` (the event that is the sitting, or the class it is held in: 「ECE 548 课程 13:00」 for 「ECE 548 期中考试 1」); `""` when it is no sitting or no same-day event shows it. Work towards it is then due by that time, not at midnight.

### Kinds

- `time` — the date is too close for the work the standard implies, or already past.
- `capacity` — this milestone's work plus what `others` puts in the same weeks exceeds a plausible share of `weeklyHours`.
- `dependency` — it waits on something not ready in time: an earlier milestone due after or just before it, a reply or data from someone else, a release date.
- `unrealistic` — the result is set higher than the starting point and the time allow: a score line well above the person's record, a growth target several times the current one, a decision by others treated as certain.
- `unclear` — nobody could say on the day whether it was reached: no measurable standard, no failure condition, no date.

### Levels

`high` — likely to miss without a change; `medium` — could miss, plan for it; `low` — worth knowing, unlikely to decide the outcome.

### Rules

- Be critical, not alarmist. Name a risk only when it follows from what is given (the dates, the numbers, the criteria, the rationale, the competing milestones), and put what it rests on into the note. Never invent facts about the person.
- `ruleFindings` are checks, not conclusions: keep those that hold, drop one the rationale answers (a derivation that shows the margin was chosen on purpose), raise or lower a level with a reason, and add what rules cannot see (whether the result is realistic, whether the work fits the time).
- At most four risks a milestone and one per kind. The note is one short clause, at most 60 characters, a noun phrase with the figures: no advice, no second person, no hedging words.

| | note |
|---|---|
| 好 | 「两周内从零写出投稿初稿」 |
| 好 | 「10/26–10/31 另有 3 个截止」 |
| 好 | 「期中线 88，往次小测平均 72」 |
| 好 | 「依赖的数据要到 11/2，截止 11/3」 |
| 坏 | 「时间可能比较紧张，建议尽早开始」 (advice, no figure) |
| 坏 | 「有一定风险」 (says nothing) |
| 坏 | 「你的时间不够」 (second person, no figure) |

Allowed tools: none. Budget: mid. Risk: routine. Evidence: the drafts and the ledger figures given.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard register, objective third person. Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线. Text quoted from the person or a source stays verbatim.

## `mode: "admission"` — Admission of a newly approved milestone (J4)

Decide whether a newly approved milestone may open now, should wait (parked) until the milestone it depends on is done, or is not worth doing — against the person's goal and the milestones already open.

The person's pattern after a setback has been to add — a new goal, a new line — without closing anything, so work in progress grows and every result slips. Their rule (2026-11-24): **milestones that depend on each other in series are not opened in parallel; the next one opens when the one before it is done. Only what is urgent and necessary is the exception.** Main lines, long-term goals and tasks are not subject to this rule; milestones are. Work the assistant does by itself does not load the person: a milestone whose remaining work is mostly the assistant's may open.

Accept `{version: "crossline.gate.admission.v1", today, goal, judge, approved, relations}`:

- `goal`: what the person works toward, verbatim.
- `judge`: the milestones to judge, newly approved: `subject`, `title`, `line`, `due`, `criteria`, `tasks` (`title`, `executor` `person`/`agent`/`mixed`, `minutes`, `progress` `finished`/`open`/`not_started`).
- `approved`: the other approved milestones, same fields. Whether one is still open, and how far along, is your reading of its tasks' `progress`.
- `relations`: `{from, to, kind}` between milestones; `enables` means `to` builds on `from` (a series).

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, one item per milestone in `judge`. Judge each against `approved` and against the others in `judge`.

### Deciding

1. Series: is the milestone in series with an open one (an `enables` relation either way, or plainly the next stage of the same work)? If so and that one is not done, the default is `park`.
2. Exception: `admit` a series milestone only when waiting would cost something that cannot be recovered — a fixed outside deadline that falls before the earlier one can finish, a window that closes — and it is necessary for the goal. Say which deadline in `reason`.
3. Not in series: `admit` when it serves the goal and the person's own remaining work on the open milestones leaves room; consider only `person` and `mixed` work as load.
4. `decline`: it does not serve the goal at all, or it duplicates an open milestone.
5. When admitting adds person-load, `detail.closeOrPark` names an open milestone to close or park in exchange (one for one), or says 「无需：不增加本人的并行度」 with why (e.g. its work is the assistant's).

- `verdict`: `admit`, `park` or `decline`.
- `detail.closeOrPark`: a milestone id, or that sentence; `detail.unparkWhen`: for `park`, what should be done first (the earlier milestone's title).
- `evidence`: the relation, due day or criteria that decided it, `quote` verbatim from the input, `kind` `event`.
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `deadline` when parking would cost a fixed outside deadline, else `quality`; `fixable` `before_step`.

### Biases to resist

A milestone written with enthusiasm or detail is not more necessary. The person approved it, but approval is not evidence it is urgent: judge from the deadlines and relations.

### Language

Simplified Chinese for `reason` and `detail` text (English when the run's style instructions say so); titles verbatim.
