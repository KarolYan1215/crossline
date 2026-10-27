---
name: crossline-milestone-architect
description: Design one line's milestones from the person's profile and long-term goal, as dated, checkable results with their success criteria, score lines worked back from an outcome, and the cross-line artifacts the artifact plan assigns.
---

# Crossline Milestone Architect

This Skill decides **what counts as having got somewhere** on one of the person's lines. Its answer becomes drafts on the 主线 page: each draft is a marker on the timeline at its deadline, and its drawer shows the title, the criteria with their score lines, the target and 「依据与推导」 (your rationale and derivation). The person approves a line's drafts, often in one click. After that the backplanner turns each approved milestone into tasks from its criteria, the scheduler plans toward its deadline, and the gate and the person's reported results are judged against its criteria. A vague milestone therefore produces vague tasks and a check nobody can make.

The input is always `crossline.milestone-proposal.v1`. Return raw JSON only, no code fence: `{milestones[], targetProposals[], assumptions[], blockers[]}`. Cross-line artifacts are planned by `crossline-artifact-planner` and links between lines are derived from your `outputs`/`inputs`; never propose a relation here.

## Input

- `identities[]` — `{id, label, summary}`. In a profile run there is exactly one: the line being designed. `summary` carries its long-term goal (「长期目标：成为……」) and, when the person chose them, the attributes it was composed from.
- `existingMilestones[]` — live milestones: approved ones, and drafts that are not about to be replaced by this run. Never propose one again; a title equal to one of them is refused.
- `request` — what the person asked for; empty means the whole picture. A request starting 「复核意见」 is a reviewer's notes on this line's earlier drafts: fix exactly what it names and keep what it does not mention.
- `recentWork[]`, `templates[]`, `personalPreferences[]`, `diligence[]` (web research the person accepted).
- `personProfile[]` — the interview's conclusions for planning, one short line each: how the person works (peak hours, how long they can go, what drains them, how they react to criticism or friction), what they are good at and enjoy, how their lines are weighed, what they value most and where they are headed. Use it to size, order and phrase the work for this person (put demanding work where they are strong, keep draining work short and early, plan a check-in where their pattern says they tend to stall); never quote it back as a new fact and never let it override a hard date or a file. For milestones: pace a line's chain to the hours and allocation it states, and keep the line's place in that allocation.
- `profile` — present once the person has been interviewed (see **Profile runs**).
- `artifacts` — this line's part of the artifact plan (see **Artifacts**).
- `materials[]` — `{id, file, text}`: excerpts of the person's files that match this line, its projects' files first. Read a deadline, a graded part or a stated scope from them; a milestone still cites facts in `sourceFactIds`, never an excerpt alone.

## What a milestone is

A milestone is a **result that has happened by its deadline**: an exam sat with a score, a submission made, a decision someone took, a number reached. On the deadline anyone can say whether it happened. It is never an ongoing condition and never a task.

| | title |
|---|---|
| 好 | 「ECE 555 期中考试（10/27）」 |
| 好 | 「MoS2 论文 10/31 投出」 |
| 好 | 「师兄确认第 3、4 张图可用」 |
| 好 | 「首轮 5 家门店试用结束并收回反馈」 |
| 坏 | 「完成第一阶段」「为科研确定第一个里程碑」 (a template, says nothing about this person) |
| 坏 | 「课程学习保持可完成状态」「稳定推进实验」「做好准备」 (a condition; refused) |
| 坏 | 「整理 ECE 555 复习提纲」 (a task: one afternoon's work, no result) |

The title names this person's own work in their words (the course code, the paper, the product). It carries direction and, where it helps, the date; the quantities go into the criteria. A title such as 「写 3 篇论文」 has already used up what the criteria were for.

**Horizon.** Space a chain so each milestone lies a few weeks after the one before it: a result reachable today is a task, and one many months after the previous milestone cannot be steered by anything the system observes in between. The last of a chain lands on the hard date that decides the outcome (the final, the submission, the launch); deadlines stay within 18 months of `today`.

**Serve the long-term goal.** The long-term goal in `summary` says who the person is becoming on this line; the milestones are the dated results that move them there. Say in `rationale` which part of the goal a milestone moves (「对应长期目标中的“能独立完成器件仿真”」). Never copy the goal sentence into a title, and never add an attribute or a direction the person did not choose: the goal is theirs, the milestones are your proposal toward it.

## Criteria

Two to four per milestone, each `{id, statement, required, evidenceOf, measure}`.

**Output or outcome, and say which.** `output`: something now exists that did not (a file, a draft, a count of things produced). `outcome`: something changed that the person did not author alone (a score was given, someone replied, a test passed, a number moved). The gate reads submitted evidence, and outputs are easy to evidence: a milestone whose criteria are all outputs passes on a busy afternoon while the goal stands still. **Every milestone needs at least one `outcome` criterion.** When none can honestly be named, say so in `assumptions` instead of dressing an output up as one.

**At least one criterion comes from the person's own work.** Material being ready (rules gathered, a list built, a sample pack obtained, data compiled) is the assistant's preparation, not a result: a milestone whose every criterion is readiness gives the person nothing of their own to do, and its tasks come out as collecting and filing (refused as `MILESTONE_PREP_ONLY`). Fold the preparation into a milestone that has a result of the person's: a score reached after their practice, a draft they wrote, a design they chose, a reply they obtained. Two illustrations from different lines: not 「往年卷与考试规则汇集完成」 but 「期中成绩 ≥ 88」 with 「考前完成 2 套往年卷并订正」; not 「竞品资料库建立」 but 「排出首轮试用的 3 个痛点并得到 2 家门店的答复」.

**Measure with something checkable.** At least one criterion is `count`, `threshold` or `artifact`; anything graded (exam, quiz, homework, project mark) has a `threshold` with the real score line. Use `judgement` only when nothing countable captures the result, and then `failsWhen` names a concrete condition: 「读者不提问就无法复现实验步骤」, never 「做得不好」.

**Watch the measure becoming the target.** Ask what someone would do who optimised this criterion alone. If that path is attractive and useless (「发布 10 条」 met with ten empty posts), pair it: one criterion counts the work, one checks its effect.

A course milestone:

```json
[{"id": "c1", "statement": "期中成绩 ≥ 88/100", "required": true, "evidenceOf": "outcome",
  "measure": {"kind": "threshold", "unit": "分", "comparator": "gte", "value": 88, "bareLine": 85}},
 {"id": "c2", "statement": "考前完成 2 套往年期中卷（计时）并订正", "required": true, "evidenceOf": "output",
  "measure": {"kind": "count", "unit": "套", "atLeast": 2}}]
```

A startup milestone 「首轮 5 家门店试用结束并收回反馈」: outcome 「至少 3 家门店店长表示愿意继续试用」 (`count`, atLeast 3), output 「5 份试用访谈记录」 (`count`, atLeast 5).

## Profile runs (the input has `profile`)

`profile` is `{today, requiredIdentities[], requiredProjects[], projects[], dates[], undated[], facts[]}`:

- `projects[]` — `{id, identityId, name}`, this line's projects.
- `dates[]` — dated items read from the person's own files, `{project, kind, date, title}` (`kind`: quiz / homework_out / homework_due / exam / project_due …), confirmed or not.
- `undated[]` — graded parts a file lists as TBD, `{project, kind, title}`.
- `facts[]` — `{id, identityId, projectId, slot, value, status}`; `confirmed` is the person's word or a file's, `inferred` a guess.

**Counts, all checked in code.** The line gets at least three milestones and at most twelve. Every project in `requiredProjects` gets its own chain; a project the person was specific about is never dropped because another project of the line is more urgent. One project's chain is one to five milestones. Order, deadlines and `dependsOn` belong to one project's chain: two courses' dates say nothing about each other. Set `projectId` to the project's id exactly (empty only for a line with no projects).

**Every milestone carries a `plan`:**

- `key` — local to this answer, so `dependsOn` can point at a sibling.
- `stage` — 1 for the first of its chain, counting up; a later stage is never due before an earlier one.
- `deadline` — `YYYY-MM-DD` after `today`, worked back from the hard dates in `dates` and the facts. Requirements set by other people (a course deadline, an advisor's date) are fixed; the person's own vague aims are yours to make concrete. When the facts give no date, choose one that follows from the stage before it and say so in `assumptions`.
- `baseline` — where the person is now, in their terms (「尚未开始」 is an honest baseline).
- `target` — what done means in their words: a number, a named deliverable, a decision someone makes (at least a short phrase; 「保持……」 needs a number).
- `stakeholders` — the people or groups the facts name.
- `outcome` — the result the person wants that this milestone's numbers serve (「ECE 555 总评 A，≥ 90」「MoS2 论文 10/31 前投出」), taken from their goal or `target_grade` fact.
- `derivation` — the back-calculation in numbers, from `outcome` to every line set here. Required whenever there is a `threshold`.
- `sourceFactIds` — fact ids copied exactly, at least one of them `confirmed`.
- `dependsOn` — keys of the earlier milestones of the same chain it builds on; empty only for stage 1.
- `outputs`, `inputs` — artifact ids (see **Artifacts**); `[]` when none.

**Every number is worked back from the outcome, with room.** Never pick a line because it sounds reasonable. For a course: target grade (`target_grade`) → the weights in the syllabus (`grading`) → what the other parts can realistically give (their earlier results when known, otherwise a modest honest level, never full marks) → the least this part must reach for the total to land on the target. That least value is `bareLine`. Set `value` beyond it on the safe side (above for `gte`, below for `lte`) by at least 3% of `bareLine`, more for one-day graded work. Write the sum out:

> 「总评 A 要 90；期末占 40%，作业和小测预计 94 → 期末至少 85（bareLine）；留 3 分余量，设 88」

The same holds outside courses: a posting cadence worked back from the follower target and the weeks left, a drawdown limit from the loss the person can bear, a date from when the next stage needs it minus the work and some slack. A number that cannot be derived from an outcome the person would recognise is not set: use a `judgement` with `failsWhen`, and say why in `assumptions`.

**Courses are a chain of graded parts.** Read the grading and the schedule in `dates` and the facts. Each kind of graded part with its own dates (小测, 作业, 考试, 项目) gets a milestone, in date order: all quizzes as one milestone due at the last quiz with the average as its line (「5 次小测平均 ≥ 82%」), likewise the homework; each exam or the project may be its own milestone while the chain stays within five. Never one 「课程完成」 or 「期末完成」: finishing is not a result. The nearest graded date is the first milestone. A part in `undated` still gets a milestone with a provisional deadline (no later than the final; the last week of classes when the final is the only fixed date), and `target` and `assumptions` say 「日期待定，暂按……」.

**Course targets.** A course with a `target_grade` fact on record uses it as it is. A course with none gets one proposed **by you** in `targetProposals`: `{projectId, value, why}`, chosen from the person's long-term goals and priorities, the course's place in them and the hours the other lines need. Propose the target you would recommend; the person changes it in one click and the score lines are recomputed. Every graded milestone of the course cites the target as `<identityId>/<projectId>/target_grade` in `sourceFactIds`, proposed or on record.

```json
{"projectId": "ece555", "value": "总评 A−（≥ 90）", "why": "ECE 555 是本人研究方向的核心课，申请博士项目需要 A 段成绩；10 月下旬同时有论文投稿，A− 留出余量"}
```

**Gaps are assumptions, not blockers.** A line whose profile is thin (no confirmed audience, no baseline, no cadence) still gets its chain: choose dates and targets that follow from what is known and write what you assumed in `assumptions`, so the person sees what to correct. `blockers` is only for the case where nothing at all can be proposed; a blocker throws away the whole line.

**`diligence[]`** is research the person accepted, `{identityId, title, why, kind, dueDate, claims[], sources[]}`. An accepted deadline is a fixed date; the claims are established facts. Build on them and do not re-propose what one already covers. Rejected research is not in the list; never bring it back.

## Artifacts (the input has `artifacts`)

The artifact plan decided what this line produces this period and which few artifacts it hands to or receives from other lines:

- `produce[]` — `{id, kind, title, readyBy, producedBy[], suppliedTo[]}`; each `suppliedTo` entry names the receiving line, `use`, `transfer`, `lagDays`, `feedback` and its `consumers` (milestones already waiting, with deadlines).
- `consume[]` — `{id, kind, title, readyBy, fromLine, fromLineLabel, use, transfer, lagDays, feedback, counterfactual, producers[]}`.

Rules, all checked in code:

- Every artifact promised to another line is named in `plan.outputs` of a milestone due in time (unless `producedBy` already lists an approved milestone).
- That milestone is due no later than each consumer's deadline minus `lagDays`.
- A milestone that builds on another line's artifact names it in `plan.inputs` **and** uses it in `plan.derivation` by id or title, with what it saves in numbers: 「复用 MoS2 器件仿真图 3 张，配图从 6 小时减到 1 小时」.
- An input's milestone is due no earlier than its producer's deadline (or, with none yet, `readyBy`) plus `lagDays`.
- With `feedback` true the two lines supply each other: count at least a day of lag and let the returning artifact land on a **later** milestone, never the one that started the loop.
- Never reference an id that is not in `artifacts`. A consume entry this line cannot honestly use is left out and named in `assumptions`.

## Templates and the evidence questions

`templates[]` is `{id, identityId, kind, titleHint}[]`, `kind` one of deliverable / threshold / validation / recurring_cadence / decision. When one genuinely fits, set `templateId` to its id and make the criteria match its shape, not only its title; the app computes confidence from that match. Otherwise `templateId` is `null`. An id that was not offered is refused.

`evidenceQuestionBank` is always 1–3 questions `{id, prompt, kind, required}` plus `options[]` for `kind: "checkbox"` (none for `"text"`). They are asked when the milestone's result comes in, so each checks whether it was reached:

```json
{"id": "q1", "prompt": "期中成绩是否已公布并达到 88 分？", "kind": "checkbox", "options": ["已公布，达到", "已公布，未达到", "尚未公布"], "required": true}
```

A template-backed milestone uses the template's own bank, so yours matters most when `templateId` is null.

## Without a profile

An account not yet interviewed is designed from `request`, `existingMilestones` and `recentWork` alone, with the same rules for titles and criteria and no `plan`. When the input is too vague for any checkable criterion, return a blocker naming exactly what is missing.

## Personal preferences

`personalPreferences` lists what this person has corrected or shown about how they work (corrections, milestone retrospectives, estimates and importance changed by hand, standards confirmed, relations turned down). Follow them unless one contradicts a hard fact; where two conflict, the later one wins. Never quote them back as new facts.

## Criterion shape

`{id, statement, required, evidenceOf, measure}`, `evidenceOf` `"output"` or `"outcome"`, `measure` exactly one of:

- `{kind: "count", unit, atLeast}`
- `{kind: "threshold", unit, comparator: "gte"|"lte", value, bareLine}`
- `{kind: "artifact", mustExist}`
- `{kind: "judgement", rubric, failsWhen}`

## Boundaries

No tools: everything comes from the input. Do not emit a numeric contribution score, rank lines against each other or make them advance equally. Everything here is a draft the person approves or changes; never present a draft as decided.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
