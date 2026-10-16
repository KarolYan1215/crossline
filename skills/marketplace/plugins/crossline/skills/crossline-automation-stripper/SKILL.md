---
name: crossline-automation-stripper
description: Separate a captured intent into reversible AI preparation and irreducible human core work, producing a bounded WorkOrder proposal.
---

# Crossline Automation Stripper

Accept `crossline.analysis.v2`: `{today, capture, approvedMilestones[] (each with its deadline, empty when none), availableInputs[], identityPacks[], referenceClass[], relations[], existingTasks[], policy}`. `title` is the task's name: a short action starting with its verb (「完成 ECE 555 作业 2」, at most 24 characters, no closing punctuation) that names the course or project when the task belongs to one, since the title is often shown alone; `intent` is the description of exactly what is to be done, written freely. Return `{identityId, projectId, milestoneId, title, intent, family, automationParts[], humanCore[], materialContract[], evidenceContract[], estimate, estimateBreakdown[], riskTier, dates[], waitingOn, byproducts[], completion, extendsTaskId, blockers[]}`.

Keep judgment, relationship ownership, authorship, and accountable decisions in `humanCore`. Automate search, extraction, comparison, formatting, and local drafts when reversible. Estimate `{p25Minutes,p50Minutes,p85Minutes,source,observationCount,confidence}` without asking for a duration. Do not perform the work or change state.

Tag every proposal with `family`: `preparation` (light setup or organizing before the real work), `review` (checking, reading, or evaluating something that already exists), or `deep_work` (sustained original production). Choose by what the task itself resembles, not by which identity it belongs to.

**What the task belongs to is worked out from everything given before it is decided**: the capture's own words, every `availableInputs[]` entry (its file name as well as its text), the approved milestones and their projects, and the relations. Choose the `projectId` and the course or project in `title` that these point to. When the task plainly belongs to some course or project (an assignment, an exam, a paper, a release) and nothing given says which, do not guess and do not fall back to a default: stop with a blocker `{code: "ANALYSIS_PROJECT_UNCLEAR", message}` whose message is the question itself, naming the candidates (「这份作业属于 ECE 555 还是 ECE 548？」). The person's answer comes back as context and the capture is analysed again.

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


## Estimating

`estimate` is **focused minutes of actual work** — the time the person is really on the task — not elapsed time, not calendar days, and with no padding for breaks, review rounds or waiting on others (the app schedules those separately). Do not round the steps up out of caution — the margin has one place to live, `p85Minutes`; an estimate that is too long is as wrong as one that is too short, and a person who always finishes in half of it learns to ignore the number.

**Work backwards from the end.** Start at what `evidenceContract` says must exist when the task is done, ask what has to be true just before that, and keep going back until you reach something the person can start on now; those are the steps. Write them in `estimateBreakdown` (`{step, minutes}`, one to eight) in the order they are done, and let **`p50Minutes` be their sum** — unpadded, within a quarter, or the answer is sent back. **The margin is stated, in `p85Minutes`**: the case where the likeliest step overruns once, between 1.2 and 3 times `p50Minutes` (outside that it is refused), sized by which step is most uncertain — an unfamiliar tool, a result you cannot know in advance — and not by adding a little to every step. `p25Minutes` is the quick case. If a step is longer than about `rhythm.focusRunMinutes` (the stretch this person really stays on work before drifting; `0` means not measured yet), it is several sittings: say so in the step's name rather than hiding it in a bigger number.

`referenceClass[]` is the outside view: recently finished tasks with what was estimated for them (`llmP50Minutes`) and what they really took (`actualMinutes`). Use them the way an estimator uses past projects — when this task resembles one, let its real duration inform the step sizes — but do not compute or apply a correction factor: the app corrects your number against this person's record afterwards, and doing it here too would count the same bias twice. A step longer than a sitting (about 90 minutes of focus) is several sittings: say so in the step's name rather than hiding it in a bigger number.

## Dates and waiting

`dates[]` (zero to four) are dates **the capture itself states**, each `{kind, date, quote, approximate}`: `release` is the earliest day the work can begin (it depends on something arriving), `due` is when it must be done. `date` is `YYYY-MM-DD`, read against `today`; `quote` is copied verbatim from the capture and must name that day (「10月8号左右」 names October 8). `approximate` is true when the person hedged (左右、大概、前后). A relative phrase that names no day (「周末前」) is not a date here — leave it out; a date whose quote does not name it is dropped by the app.

`waitingOn` is `{who, what, expectedDate, quote}` when the work cannot start until someone else delivers something (「师兄会给我真实测量数据」): who, what, the day it is expected (the same rules as `dates`), and the verbatim quote. When it waits for nobody, all four are empty strings. The app records it, keeps the work off the schedule until then, and asks the person on that day whether it came — so do not also make 「等数据」 a step.

## Getting a fact from someone

A request for a fact has four marks: its only purpose is to obtain one fact, file or confirmation that somebody else holds or decides (an exam's scope, a rubric, a format rule, a version, a date); its product is a message (an email, a chat line) plus the other side's reply; the person's own time is at most 15 minutes (check a drafted message and send it, or look the fact up in their own account); and some other work waits for the answer. Such work is a step of the task it serves, not a task of its own. When the capture is only such a request (「问助教作业 3 的提交格式」), keep the proposal that small: `p50Minutes` at most 15, `family: "preparation"`; `automationParts` drafts the message — recipient, subject, body — and never sends it; `humanCore` is the person checking the draft and sending it (sending is the person's own act, so it is not an external side effect to stop on); `evidenceContract` is one required item, 「已发出的邮件与对方的答复」. The app files a standalone request under the task it serves as that task's first step. When the capture names real work and also a fact to get first (「先问清评分标准再写报告」), the request is the first entry of `humanCore` (15 minutes) with the draft in `automationParts` — never a separate proposal. An automation part that sends the message is refused.

## Byproducts for other lines

`byproducts[]` (zero to three, at most one per line other than this task's own) name what the same work can also produce for **another** line the person has — a research run can yield notes for a post on how research really happens, or a real use of the person's own product. Each is `{lineId, milestoneId, artifact, captureSteps[], landing, why}`: `lineId` one of `identityPacks[].id` other than this task's `identityId`; `milestoneId` that line's approved milestone it serves, or empty; `artifact` a concrete thing that can be handed over (a note, a draft post, a figure), never a state (「保持状态」); `captureSteps` are small things done **during** the main work so the byproduct is cheap later (「仿真时把每次调参的想法记进研究日记」, with minutes — they are part of this task's own steps and count in `p50Minutes`); `landing` `{minutes, description}` is the short follow-up after the main work is done that turns them into the artifact. Offer one only when the work genuinely produces the material — an invented connection costs the person time. The main deliverable always comes first; a byproduct never changes this task's own contract.


## How completion is taken

`completion` says how finishing the task is taken, judged from what the work is — not from words in its title: `{mode, reason, why, question, askAfterHours}`.
- `reason` `result_pending`: the result is decided later by somebody else — an exam or quiz sat, a paper or application submitted, a review, a competition round (「Hult Prize 第一轮」), an interview, a pitch. The score or verdict is the point, so `mode` is `needs_assessment`, `question` asks whether the result is out (「「Hult Prize 第一轮」的评审结果出来了吗？」) and `askAfterHours` is when it could first be known (24 or more; the days the result is announced after, when the material says so).
- `reason` `quality`: the quality of what was made cannot be read off it at a glance (a draft, a design, a post, a piece of writing meant to persuade): `mode` `needs_assessment`, `question` asks how it went, `askAfterHours` about 2.
- `reason` `exploration`: exploring or researching with no definite product: `mode` `needs_assessment`, `question` asks what came of it, `askAfterHours` about 2.
- Everything else — handing in, finishing homework, sending, attending, filing, looking something up, solving, practising, preparing for an exam (preparing is not sitting it) — is `mode` `self_evident` (done when the person says so), with `reason` `""`, `question` `""` and `askAfterHours` 0.
`why` is one sentence on the judgement. The person can change it on the task; never ask about it.

## Work already on the board

`existingTasks[]` are the person's open tasks (the task library included): `{id, title, intent, lineId, projectId, dueDate, state}`. Read them before writing anything. When one of them already covers this capture's work (the same homework, the same material to gather, the same draft), this capture is not new work: write the analysis as usual and set `extendsTaskId` to that task's id — the app folds what the capture adds into that task's steps instead of creating a second task. Do the same when the capture only adds to one (one more problem, an extra file to read, a correction to its scope). Work that is genuinely separate — another homework number, another exam, a different deliverable, a due day more than a week apart — has `extendsTaskId` `""`.

## Personal preferences

`personalPreferences` lists what this person has corrected or shown about how they work (third-person statements: corrections told to the assistant, milestone retrospectives, estimates and importance they changed, standards they confirmed by hand, relations they turned down). Follow them unless one contradicts a hard fact in the input; where two conflict, the later one wins. Never quote them back verbatim as if they were new facts.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
