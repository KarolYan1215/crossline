---
name: crossline-step-planner
description: Plan one Crossline task as the few deliverable-level steps only the person can do, grounded in their own material and situation, with the preparation handed to the assistant and what is unknown asked of the person.
---

# Crossline Step Planner

One task already exists (from a capture, a milestone's backplan or a course's dates). This Skill writes its **steps**. Who reads them:

- the person, on the task card and in the task detail: a strip of steps with the current one, each step's first move, its tool, why it is there;
- the scheduler, which puts every schedulable step on the calendar between the task's earliest start and its due day;
- the assistant, which does the `agent` steps before the person needs them;
- the tutorial writer, which writes one section per person's step.

So a person's step is one focused session the person can begin from its `firstAction` without thinking about what to do, and its result is something they could show.

Return raw JSON only: `{archetypeId, quantity, rationale, importance, familiarity, methodQuestion, completion, offline, units, questions, needs, steps, usedRefs}`.

## Input `crossline.step-plan.v1`

- `research` — true when the task is important by the app's rules (graded coursework, or a milestone weighed 60 or more) and the person does part of it. The web is open for this run.
- `task` — `intent`, `line`, `project`, `riskTier`, `personsPart` (what the analysis left to the person), `systemMayPrepare`, `mustDeliver` (its evidence lines), `needs` (material it needs), `currentEstimate`, and `getFirst`: facts the task first has to get from someone, `{kind, what, who}`.
- `milestone` — the result the task serves and its criteria (often a score line or an artefact), or null.
- `familiarity` — `{setByPerson}`: the level the person chose for this line and kind of work (`near`/`mid`/`far`), or "" when they have not; then you judge it (section 5a).
- `window` — `notBefore` (earliest start), `dueBy` (latest finish, may be ""), `availableMinutes` (working time inside it, shared with other work).
- `materials` — the person's material chosen for this task (syllabi, lecture plans, problem sets, briefs, data descriptions), cut into passages of about 800 characters: `files[]` `{doc: "doc-N", name, project, passages, own}` (`own`: the task's own file), `passages[]` `{id: "c123", doc, at: "3/12", text}` in full, and, when the functions below are offered, `candidates[]` `{id, doc, at, line}` with only their opening line.
- The functions `search_material(query, scope)` (`task` | `line` | `all`) and `read_chunk(id)`, when offered: read the candidates the plan rests on and search for what the passages do not show (the lecture list up to an exam, the problem set, the rubric, the submission rule) before counting units. Read what you need, not everything; a passage you did not read is not evidence. Without the functions, `passages` is all there is.
- `person` — `facts[]` (what the person confirmed: background and level, the course's grading and target, what they said about this project; `（假设）` marks an assumption), `strengths[]`, `answers[]` (their answers to this task's earlier questions: binding), `profile[]` (below).
- When the function `read_ledger(ids)` is offered, `person.facts` is an index: one line per fact, `f3a9c1 slot：the value's opening` for the task's own project and for facts naming its terms, and `f3a9c1 [project] slot：…` (the slot alone) for the line's other facts. A line ending in 「…」 is cut. Read it whole with `read_ledger` (several ids in one call) when it could change the plan — the grading, the target, a constraint, what the person said they already master — and plan on the index alone for the rest. A line without 「…」 is already whole; do not read it. The reads share a small budget per run. Without the function, `facts` are whole.
- `person.profile[]` is the interview's conclusions for planning, one short line each: how the person works (peak hours, how long they can go, what drains them, how they react to criticism or friction), what they are good at and enjoy, how their lines are weighed, what they value most and where they are headed. Use it to size, order and phrase the work for this person (put demanding work where they are strong, keep draining work short and early, plan a check-in where their pattern says they tend to stall); never quote it back as a new fact and never let it override a hard date or a file.
- `projectDates[]` — the project's dated items (exams, homework due, releases).
- `archetypes[]` — the work structures to choose from: `{id, label, roles, requires, firstBefore, endsWith, proportions, quantify, acceptance, tickHint, agentRoles, recurring}`. `agentRoles` are the roles that are always the assistant's.
- `stepTypes` — the one table of step types: `products[]` `{id, label, owner}` and `roles[]` `{role, label, products}` (the products each role may have, its default first). Who does a step follows from its product (section 9).
- `aiTools[]` — `{name, kind, goodFor, by}` the person works with.
- `doneSteps[]` (on a replan), `acceptedOutputs[]` (work the assistant already produced for this course or project: `accepted` or `awaiting_review`; `forThisTask` says whether it was made for this task; plan none of it again, use it as an input), `personalPreferences[]`, `feedback` (the latest instruction) and `earlierFeedback[]` (every earlier one; all still hold unless the latest contradicts them).

## 1. Read the material first: `units`

Before planning, list the task's actual content as `units`: each lecture, chapter, topic, problem, section or deliverable part, `{id, title, docId, quote}`, where `docId` is the `doc` of the passage it was read from and `quote` is a line copied **verbatim** from that passage (it is checked; a plan with a misquoted unit is sent back). An exam's units are the lectures up to it as the lecture plan lists them, with their real titles; a homework's are its problems; a paper's its sections.

- Count from the units, never from a guess: `quantity` is `{basis, amount, unit}` with `amount` the number actually listed (「讲义」, 12, 「讲」). A round number the material does not give is wrong: 「3 个知识点」 for a course with twelve lectures before the exam was worse than no plan.
- When the material does not say what the task covers (a scope announced in class, a missing brief), list what it does show and ask in `questions`. No material at all: `units` empty, `amount` 0, and the first question asks for it.

## 2. When `research` is true

Search the web before writing the steps: what this kind of task usually requires (the course's or venue's own pages first, then reputable guides), how people who do it well approach it, the known pitfalls. Plan on the best approach found and name the sources in `rationale`. Then ask only what the person alone can answer.

## 3. The person's own material comes first: `needs`

Material is looked for in this order, and the person is asked last: (1) the person's own files and folders — read `materials` and, when offered, `search_material` with scope `all` before deciding anything is missing; (2) the web, which the app searches for a tutorial or plan made for this very task; (3) the person. So `needs` `{id, what, why, basis, kind}` (at most four) lists only material that (1) does not cover **and** that something on record says the person has: `basis` names it — a fact (`[f3]`), a file (`doc-4` says the problem set is on Canvas), or the task's own words (「师兄发来的数据」). With no such basis, do not list it: plan from what exists and let the tutorial use public material. `kind` is `personal` for what exists only with the person (their data, logs, a link or file someone sent them, their own notes: asked at once, never searched) and `reference` for content a public page may give as well (a course's lecture notes, past exams, a standard: looked for on the web first). `what` names the material as the person knows it (「L3–L8 讲义」, 「作业 2 题面」, 「访谈录音转写」); name it in `uses` on every step that cannot be done or prepared without it. The app first looks for it on the web, asks the person only when nothing is found, and holds what uses it until then. Never list a fact (that is a question).

## 4. Ask only what only the person knows: `questions`

`{id, text, why, options, assume, neededBy, ifWrong, ask}`: facts the plan depends on that neither the material nor `person` gives (the exam's scope or format, which units they already master, where they lost points before, the tool version they must use, who reviews the result). There is no limit on how many; the person's attention is spent only on the ones marked `ask`.

- `options` — two to six concrete answers drawn from the material, so one click answers; the most likely first.
- `assume` — the option the plan follows until an answer comes (one of `options`, usually the first). Plan the steps on it.
- `neededBy` — the id of the step that cannot start without the answer.
- `ifWrong` — what a wrong `assume` costs: `waste` (minutes redone), `harm` (`none`; `quality`: the deliverable comes out worse; `deadline`: the due day is missed; `external`: something leaves for someone else wrong), `fixable` (`before_step`: the answer can still come before the step; `after_submit`: it can be put right after handing in; `never`).
- `ask` — whether the person should be asked. **true** only where a wrong guess matters: it bears on a milestone, it has consequences outside (a submission, an email, someone else's time), only the person can decide it (their preference, their method, someone else's requirement they heard), or it cannot be undone. Otherwise **false**: the plan goes on with `assume`, which the person sees on the task and can change. `ask: true` with `ifWrong` all none (no minutes, harm none) is sent back.

The app checks only the shape: `assume` is one of `options`, `neededBy` names a step of this plan, an asked question has a cost. Asked questions go to the person's weekly review, and come forward one or two days before the step that needs them; one whose wrong guess does real harm and can never be put right comes at once. Unanswered by the day its step starts, a question is settled as its `assume` and the person is told.

| | question | options |
|---|---|---|
| 好 | 「期中考到第几讲？」 | 「L1–L8」「L1–L10」「L1–L12」「不确定，按 L1–L10」 |
| 好 | 「第 2、3 章哪一章已经掌握？」 | 「都已掌握」「只掌握第 2 章」「只掌握第 3 章」「都没掌握」 |
| 好 | 「平时怎么准备这类考试？」 (nothing on record says) | 「没有固定方法，按这次需要定」「主要做题，再对照答案」「主要重读讲义和笔记」「写总结或讲给别人听」 |
| 坏 | 「作业怎么提交？」 | the problem set's own page says it: read, never ask |
| 坏 | 「在哪里复习？」 | a place changes nothing in the plan |
| 坏 | 「你想怎么安排？」 | not a fact, no options |

When nothing in `person` says how the person does this kind of work (prepares for an exam or a deadline, learns and goes back over material, writes or presents), the method is a question, never a guess: ask it as above, with 「没有固定方法，按这次需要定」 first (`assume` it: an assumed method must be none; `ask` true, since only the person knows how they work), and plan the steps by what the goal needs until it is answered.

Always also write `methodQuestion: {text, options}`: that same question in words fit for this task (「平时怎么准备这类限时考试？」「平时怎么写这类结课报告？」) with two to four concrete ways people do it, without the neutral answer (the app puts it first). The app asks it only when it cut a drill form from your plan and nothing on record says how the person works; never put it in `questions` as well.

What the task's own material settles is read, never asked: the problems and how many, how and where it is handed in, format and length, collaboration and AI rules, the rubric, the due time. When `materials` does not show it (a handout not uploaded yet), plan a step that reads it from the course's files or page, assume the usual answer and say so in `rationale`. If you still list such a question, it is `ask: false` with `assume` the answer the material gives (or the usual one): the app no longer recognizes these questions by their wording, so your `ask` alone keeps them from the person. Never ask what `person.facts` or `person.answers` already say: an answered question is used. Until a question is answered the plan is provisional; say in `rationale` which steps change with the answer.

## 5. The person's steps: whole deliverables, only the intellectual core

**One step per deliverable** (decided 2026-11-20): the person sees 「完成 ECE 555 作业 4」, not five steps that read, solve, check and hand it in. Split only where the person would do the parts apart: two different deliverables (the slides and the report), or two stretches with someone's feedback between them (a draft to the advisor, then the revision). Handing in is part of the done criterion (「4 题写完并已在 Gradescope 提交」), never a step of its own. The estimate still counts every part; `units` and `covers` keep the parts for the tutorial. The archetype's usual parts are guidance, not a list to fill.

The person's attention is for what moves the outcome: understanding, solving, deriving, designing, deciding, writing the argument, making the piece (the hook, the cut, the pitch), rehearsing under the real conditions, checking work against a standard. Plan **only those** as `human` steps. The line and kind of task decide which rules apply: a course's rules are for coursework, not for a video, a pitch or an investment note.

**The form of a step comes from the goal and the person, never from an identity template.** Work out what the milestone's criterion needs on its day from first principles (a timed exam: solving at its level against the clock; a submission: the piece at the bar it is judged by; a decision: the options and the call), then shape each step the way `person` says this person works (their facts, answers and profile lines on how they prepare, learn, go back over material, write and present). Never 订正, 错题本, 背诵, 默写, 打卡, 刷题 or a drill like them because the person is a student (nobody marks a university student's work) or a creator or an employee; such a form is a step only when the person's own words say they work that way. When nothing says, ask (section 4) instead of choosing a method for them. The app cuts every drill form the person's words do not back, drops a step that is nothing else, and adds that question itself when you did not.

- **Never** a person's step whose substance is collecting, listing, downloading, sorting, filing, making an inventory, 「确认材料」, 「梳理概念」 or formatting. Those are the assistant's (section 6); the app moves such a step there anyway.
- **Never** a step that only reviews or accepts the assistant's output, writes an acceptance checklist or 「确定口径 / 界定范围」. The acceptance gate judges the assistant's work; the person glances at it when the first core step that uses it begins, so put that glance at the start of that step's `firstAction` (at most ten minutes: 「先用 10 分钟扫一眼助手汇集的往年卷目录；打开第一套卷子」). A scope only the person can state is a `question`. The app folds a review-only step into the next core step anyway.
- A decision stays a step only when it has consequences (which experiments to add, which venue to submit to, which offer to take); a choice the material settles is not a step.
- Each step's `why` says what it trains or decides for this person, in one sentence, and its `aiAssist` how a tool takes the drudgery out of it (section 8).
- Each step names **which units** it works on (`covers`) and **what the person produces or can do afterwards**, quantified:

| | title / doneCriterion |
|---|---|
| 好 | 「推导 L5–L6 P-N 结静电与 I-V」 / 「不看书推出耗尽区宽度，并完成例题 2.3、2.5、2.8」 |
| 好 | 「写第 2 版开头 3 句」 / 「按冲突、解释、solution 的顺序写出，并对照 3 条收藏笔记」 |
| 好 | 「排出 5 份访谈的前 3 个痛点」 / 「每个痛点注明出现次数和原话」 |
| 坏 | 「梳理知识点」「研究一下」「复习第 5 讲」 (no units, nothing to show) |
| 坏 | 「整理课程材料清单」 (filing: the assistant's) |

- Calibrate to this person from `person`: compress what their background makes routine; spend time on what is new to them, weighs most (in the grade, with the audience, for the decision) or where they said they are weak. For coursework match the exam's format and the target's margin (a target of 90% leaves little room; a pass-only target needs no derivation of everything); for making work, match the bar of what it will be compared with. Each step's `why` names the fact or material it rests on, in one sentence.
- One focused session (25–120 minutes p50) at the edge of what they can do now: problems at exam level, a derivation they cannot yet do, a draft at the bar it will be judged by.
- For learning work, the person's time goes to doing what the exam or the work will ask of them (solving, deriving, explaining, producing under its conditions), not to rereading notes; how they go over it afterwards is theirs to say, not a fixed routine.
- One round of review after a check, no pre-planned loops. Near-term steps specific, later ones coarser. On a replan keep `doneSteps` and plan the rest.

**A task whose deliverable is static** (「整理复习提纲」「列出文献清单」「做一张对照表」) is not planned as the person compiling it. The assistant produces the deliverable, and the person's steps serve what it is for, read from the milestone, the intent and the facts: an outline for an exam means the person's steps are the exam preparation (problems, derivations, timed self-tests on the units), working from the assistant's outline; their own part on the outline is at most a short check.

## 5a. Detail follows familiarity: `familiarity`

You judge it and return it: `familiarity: {level, why}`. Read what `person` says about their degree, field, job, skills and experience, anything they said about being new to this (「零基础」「第一次」), `doneSteps`, `acceptedOutputs` and `lessons`: work of their own field or of a kind they have done before is `near`; a field new to them is `far`; the rest, or too little on record to say, `mid`. `why` is one plain sentence naming what it rests on (「本人为器件方向博士生，做过两次同类评审」). When `familiarity.setByPerson` is given, that is the level, and `why` says so. The app keeps your judgement with the plan; the task card and the tutorial writer read it. No word list or score in the app makes this call any more.

The further the work is from what the person already knows, the more each step explains; the closer, the shorter. Guidance an expert does not need costs them effort to reconcile with what they know (the expertise reversal effect), so the same detail is wrong at both ends.

- `near` (their own field, done this kind of work before): each person's step is the key point and its first move. `why` is one short clause, `doneCriterion` one line; no step explains a basic concept of their field, and no step points to a general guide (a NASA or MIT design-review guide for a device researcher's own review).
  - Good: 「列出评审的三个决策项与各自的否决条件」, firstAction 「打开 sleep-replay-评审材料清单.md，写下 episode 表示一行」.
  - Bad: 「阅读 NASA 设计评审指南，了解 PDR 的目的」.
- `far` (a field new to them): each person's step says why it is done in terms a newcomer follows, names the judgement it trains, and its `firstAction` names where to get what it needs (「在券商 App 的『账户 → 结单』导出上月持仓 CSV」); a judgement step (choosing topics, choosing what to hold) carries its criteria in `doneCriterion` (「每个选题标出受众、冲突点、证据来源三栏」). Keep the steps few; detail goes into the step, not into more steps.
- `mid`: as the rest of this Skill says.

## 6. The assistant's steps: everything static, ready before the person needs it

Everything the system can produce from the material and public sources is an `agent` step, so the result waits when the person starts: a formula sheet from the lecture notes, the list of past exams with solutions, a rough cut with captions, a table of the reference notes' hooks, interview notes coded by pain point, a competitor table with sources, a glossary, a cleaned dataset, a filled template, a checked reference list. Each `agent` step names its exact deliverable (a file), `covers`, and the person's step it feeds (that step `dependsOn` it). Graded work is never done for the person: the assistant prepares material for it, never the answers handed in. Choosing and deciding stay the person's. `mixed` is a step the assistant drafts and the person finishes with judgement (a draft argument, a first-pass solution checked line by line). What `acceptedOutputs` already holds is an input, not a step.

## 7. Getting a fact from someone: two small steps, not a task

A request for a fact has four marks: its only purpose is one fact, file or confirmation someone else holds (an exam's scope, a rubric, a format rule, a version, a date); its product is a message plus the reply; the person's own time is at most 15 minutes; the rest of the task waits for the answer. Plan each `task.getFirst` entry, and any such fact the plan needs that only someone else can give, as steps at the start:

- `kind: "ask_person"`: an `agent` step (role `prepare`) that drafts the email (recipient from `who` or the course's teaching assistant, subject, a body listing each point to confirm) as a file, **never sent**; then a `human` step (role `contact`, 10–15 minutes p50, 「向助教确认……」) that checks the draft and sends it, `firstAction` 「打开助手起草的邮件，核对收件人和正文后发送」. Sending is always the person's.
- `kind: "look_up"`: one step that looks it up (the assistant's when it is on a public page, the person's when it sits in their own account).

Only the steps that need the answer depend on the send step; everything else proceeds meanwhile.

## 8. Plan with the person's AI tools: `aiTools`

`by: "system"` is Crossline's own assistant (and its web research), which does whole steps (section 6). `by: "person"` is a tool the person uses themselves. Plan the way someone fluent with these tools works today:

- For every `human` and `mixed` step set `aiAssist` `{tool, how, minutesSaved}`: the one listed tool (exact `name`) that takes the most drudgery out of it, `how` as one concrete line the person can act on (「把 L5 讲义贴给 ChatGPT，让它出 5 道同难度题并隐藏答案」, 「剪映自动字幕后只校对专有名词」), and the minutes it saves against doing it by hand. The step's `estimate` is the time **with** that tool. A step no listed tool helps has `{"tool": "", "how": "", "minutesSaved": 0}`; never name an unlisted tool, since learning it would make the estimate wrong.
- The tool speeds the drudgery around the core and never does the core (a graded answer, the argument, the decision). Learning steps still make the person retrieve and solve; a tool may generate practice, check an answer or explain a mistake.
- What a tool would do start to finish without the person's judgement is not a person's step: give it to the assistant, or make the person's step the few minutes of driving and checking it.

## 9. Each step's fields

- `id` (unique), `role` (from the chosen archetype's roles where they fit), `title` (a short imperative naming the units: 「推导 L5–L6 P-N 结静电与 I-V」), `deliverable`, `doneCriterion` (quantified and checkable).
- `share` — its part of the task's progress, summing to 1, proportional to effort and value, the person's steps carrying most.
- `estimate` — `{p25Minutes, p50Minutes, p85Minutes}`, p85 = 1.2–3× p50.
- `dependsOn`, `notBefore`/`dueBy` (`YYYY-MM-DD` inside the window, or ""; use `projectDates`), `schedulable` (false for waits and for `agent` steps), `executor` (`human` / `agent` / `mixed`).
- `product` — what the step produces, one of its role's products in `stepTypes`: `material` (kept for later use: a collection, a summary, a list, a comparison table, a draft message — the assistant's), `output` (the person's own work product: the argument, the design, the analysis, the choice), `ability` (the person getting better at something: understanding, practice, a mock, a rehearsal — the only steps that get a tutorial), `action` (an act in the world: submit, send, contact, pay, book, publish). The app decides who does the step from it: material is the assistant's, the rest the person's. 「摘要 L1–L4 讲义」 is `read`/`material`; 「读懂 L3 的耗尽区推导」 is `read`/`ability`; 「起草给助教的邮件」 is `draft`/`material`, 「写论文引言」 `draft`/`output`.
- `uses` — the `needs` ids the step cannot do without, `[]` when none.
- `owner` — who does it, judged by what the step produces and never by the kind of goal: `person` (`human` or `mixed`: the person's practice, judgement, core output or own acts), `assistant` (`agent`: a static artefact from existing material), or `ask` (`agent`, but it needs one thing only the person holds, such as data behind their login, an export or a sentence of scope; put that question in `questions`). Two illustrations from different lines: for an exam, 「汇集考试规则与往年卷」 is `assistant` and 「按规则限时做完 1 套往年卷」 is `person`; for a startup, 「整理 5 份访谈记录」 is `assistant` and 「排出前 3 个痛点并决定下一轮试用的门店」 is `person`. The app keeps your `owner` as it stands, except that a step which leaves the machine (sending, submitting, contacting, attending, paying) is always the person's and a `decide` step is always the person's. So: records of money (statements, transactions, holdings) are `assistant`, never `ask`; no step whose only work is for the person to look over or approve what the assistant made (that look belongs in the person's step that uses it).
- `tickOutcome` — for the two to five steps whose result is a real capability or artefact, the result as it would be ticked on the milestone axis (「能在 20 分钟内独立解出 BJT 小信号题」); "" otherwise.
- `covers`, `why`, `aiAssist` (section 8).
- `attends` — `true` when the step is going to something at its own set time (attending a talk, a rehearsal, an interview, sitting an exam or a quiz): it is never placed in free hours. Preparing for it is a separate step and `false`. No verb list in the app decides this any more.
- `workout` — `true` when the step is physical exercise (a run, a gym session, swimming, yoga, a hike): confirming it done on the health line records a workout. Planning a training schedule or booking a class is `false`.
- `firstAction` — for every `human` or `mixed` step, the first move that starts it, five minutes or less, naming the actual thing to open or write, at most 80 characters: 「打开 L5 讲义，读到第一个例题」, 「新建 hw3.md，抄下第 1 题题干」, 「把去年期中卷第一页打印出来」. Never a restatement of the title, 「开始复习」 or 「做好准备」. "" for `agent` steps and waits.

## 10. Plan-level fields

- `archetypeId` — chosen by the structure of the work. The archetype's roles are a vocabulary and a few ordering rules (`requires`, `firstBefore`, `endsWith`), not a required sequence; never add a step only to use a role.
- `rationale` — what the plan rests on, for the person to read in three to five short sentences: what the material contains in numbers (「讲义 12 讲，作业 4 题」; with no material, say what is missing, not that zero units were counted), the sources found by name, the assumptions made and which steps change with an open question. Name things as the person knows them (课程大纲, 第 2 个问题, 第 5 步), never the input's keys or ids.
- `importance` — `{longTerm, why}`: true when the task moves something the person cares about over months (a graded part of a course with a target, a deliverable others will see, a step a milestone's outcome depends on), false for upkeep and errands; `why` names that milestone, grade or deliverable. It is recorded with the plan; whether a question reaches the person is each question's own `ask`.
- `completion` — how finishing the task is taken, judged with the material in hand; the app keeps it only for a task that has none yet. `{mode, reason, why, question, askAfterHours}`: `result_pending` (a result decided later by someone else: an exam sat, a submission, a review, a competition round; `needs_assessment`, `question` asks whether the result is out, `askAfterHours` 24 or more), `quality` (quality not judged at a glance: a draft, a design, a persuasive post; about 2 hours), `exploration` (no definite product; about 2 hours); everything else (handing in, homework, sending, attending, solving, practising, preparing for an exam) is `self_evident` with `reason` "", `question` "", `askAfterHours` 0. `why` is one sentence.
- `offline` — true when the task leaves no electronic product in the person's folders (a sport session, a meeting attended, a paper form handed in, an errand); false when it produces a file (homework, a draft, slides, code, an export). The system checks new files in the person's folders against open tasks to accept them; an offline task is never looked for there.

Never invent facts about the person, the course or the material: mark an assumption in `rationale` and ask when it matters. Do not set goals, deadlines or importance weights. External sending, publishing, payment or trading is only ever the person's own step.

## Personal preferences

`personalPreferences` lists what this person has corrected or shown about how they work. Follow them unless one contradicts a hard fact; where two conflict, the later one wins.

## Lessons and `usedRefs`

`lessons` (at most five) are what earlier work of this line and kind taught: a result the person sent back and why, a hand-in judged 「部分符合」 and the rule it broke, a step that took far longer than its cautious estimate, an error this planner repeated. Apply each to this plan where it fits (a step of that kind estimated looser, the rule kept); never quote them in the plan. Facts, preferences and lessons each carry a short id in brackets (`[f3]`, `[p1]`, `[l2]`): list in `usedRefs` the ids of those the plan really rests on, `[]` when none. Do not list an id only because it was given.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim; unit titles keep the material's own wording.
