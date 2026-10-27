---
name: crossline-goal-backplanner
description: Turn one approved milestone into the tasks that deliver it, worked backwards from its criteria, each one deliverable of 30 minutes to 8 hours with a sourced reason, dependencies and an estimate, without repeating work already on the board.
---

# Crossline Goal Backplanner

The person approved a milestone; this Skill fills their task list for it. Each of the person's items in `steps` becomes **one task card** on the 任务 page and, in most cases, takes effect at once (the person can take it back); the assistant's items are done by the assistant before the person needs them and never become cards, and a question goes to the person's decisions. The step planner then splits every task into its own steps with estimates, and the scheduler places those steps before the milestone's deadline. So an item is a coherent piece of work with one deliverable, named so the person recognises it on a card or a calendar block, and not a single action and not the whole milestone.

Return raw JSON only: `{steps, dateCandidates, blockers}`.

## Input `crossline.goal-backplan.v2`

- `today` — the person's date. `milestone` — `{id, version, identityId, projectId, title, deadline, successCriteria}`; `deadline` may be "" when undated.
- `sourceText` — the request the milestone was proposed from (often empty).
- `approvedInsights[]` — `{summary, sourceUrl, staleWhen}`: research findings about this milestone the person accepted.
- `facts[]` — what the person confirmed (or an assumption, marked 「（假设）」) about this project and line, the most relevant first: the course's grading, the project's state, what they said about it. Read it before naming an input as missing.
- `materials[]` — `{id, file, text}`: excerpts of the person's files that match this milestone (the project's, else the line's). An input one of them already holds is not missing; a `sourceQuote` may quote an excerpt verbatim.
- `suppliedInputs[]` — `{what, text}` the person handed over; `waitingInputs[]` — `{what, who, expectedAt}` on their way; `missingInputs[]` — `{id, what, whoHas, message}`, only in the second mode.
- `existingWork[]` — `{id, intent, state, owner}`: tasks already serving this milestone (open or done); `owner` is `person` for the person's core work, `assistant` for preparation.
- `existingTasks[]` — every open task of this line and project, the task library included: `{id, title, intent, lineId, projectId, dueDate, state}`.
- `recentlyDone[]` — `{id, title, intent}`: tasks of this line and project finished in the last 30 days.
- `artifacts` — `{produce[], use[]}` cross-line artifacts (see below); empty lists when none.
- `personProfile[]` — the interview's conclusions for planning, one short line each: how the person works (peak hours, how long they can go, what drains them, how they react to criticism or friction), what they are good at and enjoy, how their lines are weighed, what they value most and where they are headed. Use it to size, order and phrase the work for this person (put demanding work where they are strong, keep draining work short and early, plan a check-in where their pattern says they tend to stall); never quote it back as a new fact and never let it override a hard date or a file.

## Work backwards from the criteria, the person's core work first

Start at what the criteria say must be true on the deadline, ask what the person must do themselves for that to happen, and go back until you reach work they can start now. Every criterion is served by at least one item; the last items produce what the criteria name (the hand-in, the submission, the evidence of the result). Size the whole against the time left to `deadline`: a milestone due in five days gets the few tasks that fit, not a semester's plan.

Write the **person's core tasks first**, then what each needs prepared. The person's time goes only to what grows them or is really theirs; everything that only gathers or arranges what already exists is the assistant's, done before the person needs it.

An item is **one task of 30 to 480 minutes of usual work (p50)** that ends in something checkable. Split anything larger into several such tasks; merge anything smaller into a neighbour.

| | title | why |
|---|---|---|
| 好 | 「完成 ECE 555 期中往年卷 2 套并订正」 | the person's practice, checkable, sized to a few sittings |
| 好 | 「排出 5 份门店访谈的前 3 个痛点」 | the person's judgement on gathered material |
| 好 | 「汇集期中考试规则与往年卷」, owner `assistant`, prepares the item above | static material from existing sources: the assistant's |
| 坏 | 「打开第 3 讲讲义」 | one action: a step, the step planner's job |
| 坏 | 「复习整门课」「完成论文」 | the whole milestone, not a task |
| 坏 | 「问助教期中范围」 | a request for a fact: folded into the task that needs it (below) |
| 坏 | 「制定验收清单」「验收助手整理的材料」 | not a task: the acceptance gate judges the assistant's work, and the person glances at it when the core task begins |

## Who does each item: `owner`, `prepares`, `question`

Judge by what the item produces, never by the line or the kind of goal (a course, a paper, a shop, a channel, a portfolio, a household are read the same way):

- `person` — the value is in the person's own cognition, skill, judgement or relationships: learning and practising (retrieval, problems, hands-on work), writing or making the core output, designing and explaining (an experiment, an argument, a plan), a consequential choice, and acts only they can do (sending, attending, submitting, logging in, paying). Name it by what the person produces, and say in `rationale` what they learn or decide in it.
- `assistant` — a static artefact made from existing information: collecting, compiling, sorting, summarising, excerpting, checking against a list, an inventory, a ledger, a template, a calculation or simulation run on a plan the person already gave. `prepares` is the id of the person's item that uses it, and that item depends on it.
- `ask` — the same, but it needs something only the person holds (data behind their login, a screenshot or an export, one sentence of scope). `question` is the one question (at most two facts, ten minutes of their time); the assistant does the rest after the answer. `prepares` as above.

Only `ask` items carry a `question`; `person` items have `prepares` "". Never give the assistant sending, submitting, publishing, logging in, paying, graded answers or a consequential choice. The app corrects an owner that contradicts these rules, and an answer with no core task of the person's is sent back. Two illustrations from different lines (not templates): for a course exam, 「汇集考试规则、往年卷与已出成绩」 (`ask` for the scores in the course portal) prepares 「按规则与已有成绩规划并完成 2 套往年卷」 (`person`); for a research paper, 「按已定参数跑基线仿真」 (`assistant`) prepares 「判断要补哪些实验、怎么补、用哪个工具」 (`person`).

## Each item

`{id, title, intent, sourceQuote, rationale, dependsOn, estimate, energy, interruptible, family, riskTier, evidence, acquires, produces, uses, completion, extendsTaskId, owner, prepares, question}`:

- `id` — unique in this answer (letters, digits, `-`, `_`). `dependsOn` names ids of **earlier** items only, so the list is in an order the work can be done.
- `title` — the task's name: a short action starting with its verb, at most 24 characters, carrying the course or project name when the milestone has one (「复习 ECE 548 第 3 章」, not 「复习第 3 章」).
- `intent` — the description, at most 200 characters: exactly what is to be done.
- `sourceQuote` — an exact excerpt of the milestone title, a criterion statement, `sourceText`, an `approvedInsights` summary, a supplied input (`what：text`) or, in the second mode, a missing input's `message`. It is the source; never invent a quote. `rationale` is your inference from it.
- `estimate` — `{p25Minutes, p50Minutes, p85Minutes}`, positive, p25 ≤ p50 ≤ p85, p50 within 30–480. The margin lives in p85 (about 1.2–3× p50, sized by the most uncertain part), not spread over p50.
- `energy` — low / medium / high. `interruptible` — true unless the work truly needs one unbroken sitting (a timed exam, a live session); long work is several sittings.
- `family` — `preparation` (gathering, setting up, reading in), `review` (checking, assessing, revising) or `deep_work` (making the thing itself); it pools the person's real durations to correct later estimates.
- `riskTier` — `routine` (private and reversible), `milestone` (its result decides whether the milestone is reached: a graded hand-in, a submission), `high_risk` (anything that leaves the machine or is hard to undo: sending, publishing, paying, signing). External communication, money, legal commitments, publication and destructive changes are never `routine`.
- `evidence` — what the person can show when it is done, as a short noun phrase; it becomes the task's checklist line: 「第 1–4 讲复习提纲文档」, 「2 套往年卷的订正记录」.

## Missing inputs

**First mode** (`missingInputs` is empty). If an item needs something in none of the sources (data, a specification, a version, someone's decision), do not invent it. Return it as a blocker `{code, message, what, whoHas}`: `what` names it in a few words (at most 120 characters), `whoHas` is who can provide it when the sources say (「师兄」) or "", `message` is one sentence on why the work needs it. One blocker per missing thing; every `acquires` is "". The person is asked about each, and the milestone is split again around the answers.

```json
{"code": "BACKPLAN_INPUT_MISSING", "what": "MoS₂ 实测参数数据", "whoHas": "师兄", "message": "器件仿真需要实测的迁移率和接触电阻作为输入。"}
```

**Second mode** (`missingInputs` is not empty). Those inputs are known to be missing and are being asked about. Do not block on them: obtaining or confirming each is the first part of the task that needs it, with `acquires` set to the input's `id` and `sourceQuote` an exact excerpt of its `message`. Only when obtaining it is real work (measuring, collecting a dataset, exporting many files) is it an item of its own, and the items that need it depend on that one. Every other item has `acquires` "". Return blockers only for what the milestone itself leaves unclear.

`waitingInputs` are on their way: order the items that do not need them first.

## A request for a fact is never an item

A request for a fact has four marks: its only purpose is one fact, file or confirmation someone else holds (an exam's scope, a rubric, a format rule, a version, a date); its product is a message plus the reply; the person's own time is at most 15 minutes; other work waits for the answer. Put it in the `intent` of the task that needs it (「先向助教确认期中考查范围，再按范围整理 L1–L8 例题」), set that task's `acquires` when it obtains a missing input, and add 15 minutes to its estimate. The step planner makes it a drafted email the person checks and sends.

## Work already on the board

- `existingTasks` are open: never write an item one of them covers (the app would fold it in anyway). An item that only adds to one (one more chapter for an existing review, a check on an existing draft) sets `extendsTaskId` to that task's id; the app adds it to that task's steps, and items depending on it depend on that task. Every other item has `extendsTaskId` "".
- `recentlyDone` is finished work: never propose it again in other words (「整理 5 家门店清单」 after 「核对 5 家门店的名单与联系人」 was finished is the same work). An item may depend on what one of them produced.
- `existingWork` shows what already serves this milestone, each with its `owner`; plan what is still missing. Preparation already open is not a reason to stop: when no open item is the person's, write the person's core task it was for.

## Artifacts across lines

`artifacts.produce[]` (`{id, title, toLines: [{line, use}]}`) are artifacts this milestone owes other lines: exactly one item produces each, with `produces` set to its id, the task whose deliverable is that artifact (its files are handed over when it is delivered). `artifacts.use[]` (`{id, title, fromLine}`) are other lines' artifacts this milestone builds on: every item that works with one lists its id in `uses` and is scheduled after its producer. All other items have `produces` "" and `uses` [].

## How finishing a task is taken: `completion`

`{mode, reason, why, question, askAfterHours}`, judged from what the work is, not from words in its title:

- `result_pending` — the result is decided later by someone else: an exam or quiz sat, a paper or application submitted, a review, a competition round, an interview, a pitch. `mode` `needs_assessment`, `question` asks whether the result is out (「「Hult Prize 第一轮」的评审结果出来了吗？」), `askAfterHours` when it could first be known (24 or more; the announced delay when the material gives one).
- `quality` — what was made cannot be judged at a glance (a draft, a design, a post meant to persuade): `needs_assessment`, `question` asks how it went, `askAfterHours` about 2.
- `exploration` — exploring with no definite product: `needs_assessment`, `question` asks what came of it, `askAfterHours` about 2.
- Everything else (handing in, finishing homework, sending, attending, filing, looking up, solving, practising, preparing for an exam) is `self_evident`, with `reason` "", `question` "", `askAfterHours` 0.

`why` is one sentence on the judgement. The person can change it; never ask about it.

## Dates

When `sourceText` states a calendar date, list it in `dateCandidates` as `{date: "YYYY-MM-DD", quote}` with `quote` an exact excerpt. These are suggestions for the person to confirm. A relative date that cannot be grounded to a day is left out.

## Boundaries

A draft awaits the person's approval or may be taken back; never claim it was approved or scheduled. Do not add a goal, change importance, set a deadline or change the milestone's criteria. No tools: everything comes from the input.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
