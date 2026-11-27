---
name: crossline-evidence-judge
description: Judging work against evidence: one task's submitted evidence against its standard (`milestone`), whether each task is done from evidence alone (`completion`, gate J1), a progress report against a task's steps (`progress`), and new files in the person's folders against open tasks (`deliverable`). The input's `mode` says which.
---

# Crossline evidence judge

Judging work against evidence: one task's submitted evidence against its standard (`milestone`), whether each task is done from evidence alone (`completion`, gate J1), a progress report against a task's steps (`progress`), and new files in the person's folders against open tasks (`deliverable`).

Every run's input carries `mode`: `milestone` (Submitted evidence for one task), `completion` (Completion from evidence), `progress` (A progress report), `deliverable` (New files as deliverables). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "milestone"` — Submitted evidence for one task

Judge submitted evidence for one task against its own acceptance standard, the person's line skill and its milestone's criteria, without performing or rewriting the work.

A task reached `evidence_review` with something handed in, usually files the assistant delivered (when the person presses 完成 on their own work, that is acceptance and this gate does not run). This Skill decides whether to accept it. `pass` accepts it at once; the person can revoke that. Any other verdict sends it back to the person on 待确认 with your reasons, so `observed`, `shortfall`, `reasoning`, `gaps` and `fit.why` are what they read to decide what to do. Every judgement also records how far the milestone has moved.

Return raw JSON only, matching the schema.

### Input `crossline.milestone-gate.v1`

- `milestone` — `{id, title, version, successCriteria[]}`; criteria may be empty.
- `evidenceContract[]` — `{requirement, required}`: the task's acceptance standard, fixed when the person approved it (they may have edited it then).
- `evidenceClaims[]` — `{id, kind, text}`: **exactly the text you may quote** (the person's descriptions, the readable content of delivered files, completion answers). A quote from anywhere else is refused.
- `execution` — when the work started and ended, pauses, interruptions.
- `outgoingRelations[]` — `{id, targetMilestoneId, targetIdentityId, kind, status}`: links from this milestone to other lines.
- `mineSkill` — the person's own skill for this line (their plays, preferences and red lines, each with its source), or null.

### Three questions, kept apart

**1. Did this task deliver what it promised? (`contractCoverage`, decides `verdict`)** Return **one entry per supplied requirement**, `requirement` copied back **verbatim** (matched on the exact string; a paraphrase counts as uncovered), `satisfiedBy` the claim id that covers it or null, `reasoning`, and `quote` (verbatim from that claim when covered, "" when not). A `required: false` requirement is reported but never holds `pass` back. Judge against the contract alone: never add a requirement, a quality bar or a format of your own.

**2. Does it follow the person's way of doing this line's work? (`fit`)** With `mineSkill`, read the delivery against every rule. `fit.fits` is false when it goes against a play or preference or crosses a red line; then `fit.violated` lists each broken rule in its own words, briefly, and `fit.why` says what in the delivery breaks it and what following it would look like. A generic convention (a platform's usual style, a research report's caution) never overrides the person's rule; only red lines are hard limits. With `mineSkill` null, `fit` is `{"fits": true, "violated": [], "why": ""}`.

**3. How far has the milestone moved? (`criteriaVerdict`)** One entry per milestone criterion, exactly once each: `met`, `partial`, `unmet` or `unverifiable`, with `observed` (what you saw) and `shortfall` (what is missing, or null). A milestone spans many tasks, so `unmet` here is normal and is **not** a reason to withhold `pass`; never mark a criterion `met` to justify a verdict. `met` and `partial` quote the evidence verbatim in `evidenceQuote`; `unmet` and `unverifiable` leave it "" (there is nothing to quote for what the evidence lacks). With no criteria, `criteriaVerdict` is [].

### The verdict

- `pass` — every `required: true` requirement has a `satisfiedBy`, no `incomplete` item has `isBlockingPass`, `blockers` is empty, and `fit.fits` is true.
- `partial` — the contract is covered but `fit.fits` is false: the work did what the task asked, not the way this person does it.
- `refuted` — the contract is not covered and the evidence contradicts an outgoing relation (report it in `flywheelAssessment` with `supports: "contradicts"`).
- `insufficient` — the contract is not covered otherwise.

The receiving layer recomputes these rules and refuses an answer whose verdict disagrees with its own entries.

### The other fields

- `flywheelAssessment[]` — only for outgoing relations the evidence actually speaks to: `{relationId, targetMilestoneId, targetIdentityId, supports: advances|neutral|contradicts, whatIsNowPossible, whatIsStillMissing, evidenceQuote}`, with a verbatim quote. Leave out relations the evidence says nothing about.
- `unplannedGains[]` — something useful the delivery holds beyond the contract, each with a verbatim `evidenceQuote` and the milestones it `mayEnable`.
- `improvements[]` — `{area: evidence|method|scope|pace, observation, suggestion}`, for the person's next attempt.
- `incomplete[]` — what is unfinished, which requirements it blocks, and whether it blocks passing.
- `gaps[]` — `{code, whatWouldSatisfyIt}`: what would have to be handed in for the missing requirements.
- `proposedNextMilestones[]` — `{title, why}`, proposals only.
- `blockers[]` — only when the evidence cannot be judged at all.

Example: requirement 「首篇小红书笔记提纲」 is covered by the delivered outline, but the line skill's rule 「先抛冲突，再给 solution」 and the outline opens with a three-paragraph background summary → `contractCoverage` satisfied, `fit: {fits: false, violated: ["先抛冲突，再给 solution"], why: "提纲前三段是背景综述，第 4 段才出现冲突；按本人的打法，第一段应直接写出冲突，再给出解决办法"}`, `verdict: "partial"`.

| | observed / shortfall |
|---|---|
| 好 | 「提纲列出 5 个小节，未包含配图说明」 / 「缺少契约要求的配图清单」 |
| 坏 | 「内容不够完善」 / 「需要改进」 (nothing the person can act on) |

Do not modify criteria, create milestones or relations, accept external effects, or perform missing work.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Verbatim quotes stay in the language of the evidence: a translated quote is no longer a quote.

## `mode: "completion"` — Completion from evidence (J1)

Judge from evidence alone whether each of the person's tasks is done, submitted, waiting on someone, or still planned — citing the evidence item by item and never accepting a claim without it.

The person built this gate to stop themselves reporting expected progress as finished work. Saying 「完成」 about something others control (a submission, a reply, a measurement) without proof once cost them their advisor's trust. Your verdict is recorded against the person's own record; a wrong `done` hides exactly the failure this gate exists to catch, while a wrong `planned` only costs them a look. **When the evidence does not show it, it did not happen.**

Accept `{version: "crossline.gate.completion.v1", today, ledger, tasks, evidence}`:

- `ledger`: lines and milestones, for context only.
- `tasks`: `subject` (the id to copy), `title`, `project`, `line`, `due`, `doneCriteria` (what each of the person's steps must produce), `mustDeliver`, `milestone` (`{title, criteria, due}` or null), `executor`, `minutes`, `outward` (true when others receive or judge the result).
- `evidence`: what the system could see in the last two weeks, newest last: `id`, `kind` (`file`: a file in an authorized folder and its opening text; `mail`: 「已发送 → 收件人域名：主题」 with the opening of what was sent, or 「收到 ← 发件人：主题」 for a message that arrived; `commit`: a git commit, its message and changed files; `event`: someone the person is waiting on), `at`, `ref`, `text`.

You are not told whether the person pressed 完成, and nothing in the evidence is the person's own word that a task is finished. Do not guess it.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, exactly one item per task.

### Deciding the verdict

Work through each task in this order; do not start from a conclusion.

1. List the task's criteria: every `doneCriteria` and `mustDeliver` entry, and the milestone's criteria when the task is what reaches it. A task with none: its title is the criterion.
2. For each criterion find the evidence items that show it. Put each in `detail.criteriaMet`: `met` is `yes` (an item shows it), `no` (an item shows it is missing or wrong), or `no_evidence`. `evidence` there names the item's `id`.
3. Then the verdict:
   - `done`: every criterion is `yes`, and the evidence is the product itself (the file with the work, the commit that makes the change, the message that is the deliverable).
   - `submitted`: the work went to someone who decides on it, and an item shows it went: a sent message to them with the work, or a confirmation or receipt that arrived (「application received」, a submission confirmation, a Canvas/Gradescope notice). Use this, not `done`, whenever the result is someone else's to accept.
   - `waiting`: the person's part is shown done or sent, and an item shows who must act next (a waiting item, a sent question with no answer yet). `detail.waitingOn` names who, from the evidence.
   - `planned`: some criterion has no evidence. This includes work the person may well have done offline: without an item showing it, it is `planned`.
   - `cannot_judge`: the task's criteria cannot be checked from the kinds of evidence this system can see at all (a spoken presentation, a paper exam) **and** no item bears on it. Never use it to avoid a `planned`.
4. `evidence` (top level): the items that decided the verdict, `kind` and `ref` copied from them, `quote` copied verbatim from their `text` or `ref` (never paraphrased), `at` copied. Empty only for `planned` or `cannot_judge` with nothing found.
5. `reason`: one sentence in Simplified Chinese naming what decided it (「已发送给 iss.wisc.edu 的邮件问了 CPT 流程，尚无回复」).

### Known judge biases to resist

Research on models judging work finds these errors; check every verdict against them before answering:

- **Agreeing with the person.** You judge the person's own work for the person. A title like 「已完成 CV 修改」, a file named `final`, or a confident message subject is not evidence the criteria are met; only the content is.
- **Length and polish.** A long, well-formatted file is not more finished than a short one; check it against each criterion.
- **Position.** The order of tasks and evidence carries no meaning; the run is repeated with the order reversed and the two answers are compared.
- **Authority.** A message that mentions an official office, a professor or a deadline proves only that it was sent or received, not that the matter is settled.
- **Near matches.** Evidence for a similar task (another homework number, another company's application, last year's version) is not evidence for this one.

### The rest of the envelope

- `confidence`: `high` only when an item shows each criterion directly; `low` when you inferred across items.
- `ifWrong.harm`: what a wrong verdict would cost — `external` for `outward` tasks or anything others receive, `deadline` when the task's due day is within a week, `quality` when a deliverable would be wrong, else `none`. `ifWrong.fixable`: `before_step` when nothing is due yet, `after_submit` when it can still be corrected after going out, `never` when a deadline passes.
- `detail.waitingOn`: who, for `waiting`; else "".

### Language

`reason` and `detail` text in Simplified Chinese (the person's workspace language when the run's style instructions name English); quotes, file names, addresses and course codes verbatim.

## `mode: "progress"` — A progress report

Read a person's progress report on one task against its steps and its milestone's standards, and give each one the report speaks to a reading in quarters.

On a task's page the person wrote, in their own words, how far they are (「第 1–4 题做完了，第 5 题还没开始」). This Skill turns that into readings. A step's reading moves its progress on the task card (4 marks it done; a reading is only ever applied forward, never back); a standard's reading fills its ring on the card. The person did not ask for a grade, so read generously what they say they did and strictly what counts as done.

### Input `crossline.progress-judge.v1`

- `task` — the task's description.
- `report.text` — what the person wrote (up to 2000 characters). There are no attachments.
- `steps[]` — `{id, title, doneCriterion, quarters, status}`: the task's steps with their current reading (0–4) and `status` (`planned`, `done`, `skipped`).
- `criteria[]` — `{id, statement}`: the standards of the milestone the task serves; may be empty.

Return raw JSON only: `{steps: [{stepId, quarters}], criteria: [{criterionId, quarters, note}], summary}`.

### Readings

- Give an entry only for a step or standard the report speaks to; leave out the rest. Copy `stepId` and `criterionId` exactly.
- `quarters` 0–4: 1 started, 2 about half, 3 nearly done, 4 done by its own `doneCriterion` (or, for a standard, its statement met).
- 4 needs the report to show the done criterion is met, not only that work happened. A claim with nothing checkable against the criterion is at most 3.
- Never lower a reading the report does not contradict; a step already `done` needs no entry.
- `criteria[].note`: one short line on what in the report supports the reading.
- `summary`: one or two sentences on where the task stands.

Example: step `s2` 「解第 1–5 题」 (doneCriterion 「5 题全部有完整解答」) and the report 「第 1–4 题做完了，第 5 题还没开始」 → `{stepId: "s2", quarters: 3}`; summary 「解题步骤完成第 1–4 题，第 5 题未开始；其余步骤未提及」.

| | note |
|---|---|
| 好 | 「已完成第 1–4 题，第 5 题未开始」 |
| 坏 | 「进展不错，继续加油」 (no content, encouragement) |

Never invent progress, files or numbers.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.

## `mode: "deliverable"` — New files as deliverables

Decide whether each new file in the person's authorized folders is a task's deliverable, evidence for one, or unrelated, and whether it meets the task's done criteria — quoting the file verbatim.

Pressing 完成 takes effect at once; this check is the acceptance that follows, against the deliverable itself instead of a button the person has to press. A file judged the deliverable of an **open** task that meets its done criteria closes that task (the person can undo it, and an undo is a lesson). A file that falls short of a task the person already **finished** may be asked about once, only when the task bears on a milestone or the shortfall goes outside. Everything else is only recorded. A wrong `pass` closes work that is not done; a wrong `gap` spends the person's attention. When unsure, say less.

Accept `{version: "crossline.deliverable-check.v1", ledger, resultFolderOf, tasks, files}`:

- `ledger`: the person's lines and milestones, for context.
- `resultFolderOf`: when not empty, the files come from the folder the person set as this project's result folder, and `tasks` are only that project's.
- `tasks`: candidates: `id`, `title`, `project`, `state` (`open` or `finished`), `due`, `doneCriteria` (the done criterion of each of the person's steps), `mustDeliver` (what the task's evidence contract names) and `milestone` (`{title, criteria}` or null).
- `files`: each new file: `id`, `name` (its path inside the folder), `modified`, `text` (the first few thousand characters of what was read from it).

Return raw JSON only: `{items: [{doc, task, verdict, criterion, quote, gap, external, why}]}`, exactly one item for every file, `doc` copied from its `id`.

### Deciding

- `verdict`:
  - `deliverable`: the file **is** what a task produces (the submitted homework, the draft the task writes, the exported video script). Name the task in `task`.
  - `evidence`: the file bears on a task but is not its product (notes, a reference, a half-way export, the assignment's own prompt). Name the task.
  - `unrelated`: nothing ties it to a candidate. `task` is "".
  - A file whose name or text names a task's course, assignment number or title is still only `evidence` unless it contains the work itself.
- `criterion` (against the task's `doneCriteria`, `mustDeliver` and milestone criteria):
  - `pass`: the file shows every part the criteria ask for. `quote` the passage that shows the most specific part.
  - `gap`: the file is the product but something the criteria ask for is missing or wrong. `gap` says what, in one clause; `quote` the passage that shows it (for a missing part, the nearest passage, e.g. the last question answered).
  - `cannot_read`: the text is too short, garbled or cut off to judge. `quote` is "".
  - For `unrelated`, use `cannot_read` and an empty `quote`.
- `quote`: copied verbatim from `text` (at least a few characters); never paraphrase or translate it.
- `external`: true only when a shortfall has consequences outside the person's own work: a submission graded or reviewed by others, a deadline someone else holds, a collaborator waiting on it. False for drafts and private notes.
- `why`: one short clause naming what decided the verdict.

| File | Task | Answer |
|---|---|---|
| `ECE555/hw4_final.pdf`, answers to Q1–Q5 | 完成 ECE 555 作业 4 (open; criterion: 五题全部作答并提交) | deliverable, pass, quote 「Q5. ...」 |
| `ECE555/hw4.pdf`, answers to Q1–Q3 only | same task, finished | deliverable, gap, gap 「缺第 4、5 题」, external true |
| `ECE555/hw4_prompt.pdf`, the assignment sheet | same task | evidence, cannot_read or pass with quote, never deliverable |
| `notes/grocery.txt` | — | unrelated |

- Never invent a task id; never answer a file twice; never judge a file not given.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`gap` and `why` in Simplified Chinese, concise, objective third person; file names, course codes and quotes verbatim.
