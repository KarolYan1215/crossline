---
name: crossline-focus
description: What comes first: each open task marked P1 and/or outward-facing this week (`priority`, gate J2), and today's one small outside gate put first on Today (`front`, gate J3). The input's `mode` says which.
---

# Crossline focus

What comes first: each open task marked P1 and/or outward-facing this week (`priority`, gate J2), and today's one small outside gate put first on Today (`front`, gate J3).

Every run's input carries `mode`: `priority` (This week's P1 and outward tasks), `front` (Today's front task). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "priority"` — This week's P1 and outward tasks (J2)

Mark each of the person's open tasks this week as P1 (cannot be dropped) and/or outward-facing (others receive or judge the result), against their stated goal and milestones, citing why.

The person's plan says: each week, at most about five P1 — the actions that must be handed to someone else this week, on the path to their goal — and nothing new gets planned until those close. You mark them, so the person is not the one deciding which of their own tasks count. Other gates rely on your marks: P1 and outward tasks are checked twice for evidence of completion, and an outward task marked done without evidence is counted against the person.

Accept `{version: "crossline.gate.priority.v1", today, weekStart, goal, ledger, tasks}`:

- `goal`: what the person has said they are working toward (their long-term goals per line, and any objective they wrote down), verbatim.
- `ledger`: lines, approved milestones with their due days, and what each needs to be reached.
- `tasks`: all open tasks: `subject` (the id), `title`, `project`, `line`, `due`, `doneCriteria`, `mustDeliver`, `milestone`, `executor` (`person`, `agent`, `mixed`), `minutes` (estimate, or null).
- `judge`: the ids to mark in this run (the week's first run: all of them; later runs: tasks that appeared since). The other tasks are there so you can weigh these against the whole week.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, exactly one item per id in `judge`.

### Deciding

- `verdict`:
  - `p1_external`: on the critical path of a milestone or goal **this week or next**, and its result goes to someone who receives, reviews or decides on it (an application, a submission, a draft to an advisor, an email an office must answer).
  - `p1`: on that critical path this week or next, but the result stays with the person (an experiment run that a submission waits on).
  - `external`: others receive or judge the result, but it is not on this week's critical path.
  - `normal`: everything else.
- Aim for about five P1 in a week — a goal, not a cap. More than that means not all of them are really this week's; fewer is fine when the week has fewer.
- A task the assistant does alone (`executor: agent`) is rarely P1: P1 is about what only the person can hand over.
- A small step that unblocks a large outside result is P1 even when it looks trivial (an email that a visa authorization waits on; sending a draft an advisor must read before a submission).
- `evidence`: the milestone, due day or goal line that decided it, `kind` `task` or `event`, `ref` the milestone or task id, `quote` verbatim from the input.
- `reason`: one sentence in Simplified Chinese: what it unblocks and by when.
- `ifWrong`: `harm` `deadline` when a wrongly dropped P1 would miss its due day, else `quality` or `none`; `fixable` `before_step` unless a deadline falls within two days (`never`).
- `confidence` as usual; `detail` is `{}`.

### Biases to resist

Do not mark a task P1 because its title sounds urgent or important, because it is long, or because it comes first in the list. Mark it from its place on the path to a milestone or the goal.

### Language

`reason` in Simplified Chinese (English when the run's style instructions say so); titles and quotes verbatim.

## `mode: "front"` — Today's front task (J3)

Pick today's one small outside gate — a cheap task the person keeps postponing that a high-value external result waits on — to put first on Today, with what one more day of delay costs.

The person's diagnosis of themselves: the big results that others judge (a paper, an internship offer, a tape-out) all sit behind a chain of cheap outside gates — sending a draft to the advisor, an email an office must answer before work authorization, submitting an application — and those cheap gates are what they postpone. Each day you pick at most one such task and it goes first on Today.

Accept `{version: "crossline.gate.front.v1", today, goal, ledger, tasks, ratio}`:

- `goal`: what the person works toward, verbatim.
- `ledger`: lines, milestones with due days and criteria.
- `tasks`: open tasks: `subject`, `title`, `line`, `due`, `doneCriteria`, `milestone`, `executor`, `minutes` (the estimate corrected by the person's own record when that correction has proved itself), `p1`, `outward`, `status` (the completion gate's latest verdict: `planned`, `waiting`, …, or "" when not judged), `waitingOn`, `daysOpen` (since the task appeared).
- `ratio`: how the person's actual time compares with estimates (`median` actual/estimate over the last four weeks, `n` tasks), or null when not measured yet.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}` with exactly one item whose `subject` is `today`.

### Deciding

The target, as the person wrote it: **low cost (about three hours or less, after the ratio) and on the critical path of a high-value external result**. Judge both parts, not one:

1. Cost: use `minutes` and multiply by `ratio.median` when it is given. A task that needs a long stretch of work is not a small gate, however important.
2. Critical path: an external result (a submission, an offer, an authorization, an advisor's review) cannot move until this task is done, and that result bears on a milestone or the goal. A task that is merely useful is not on the path.
3. Prefer the task that has been open longest and whose delay costs most. A task `waiting` on someone else is not the person's to do — unless the person's part is a follow-up the evidence shows is overdue.
4. When nothing qualifies, answer `none`. An empty day is better than a wrong pick: the pick displaces whatever Today would have put first.

- `verdict`: `front` or `none`.
- `detail.task`: the chosen subject id ("" for `none`); `detail.minutes`: the corrected cost estimate; `detail.costOfDelay`: one sentence in Simplified Chinese on what one more day of delay costs, concrete and dated when the evidence allows (「每晚一天，ISLPED 倒排少一天给导师改稿」).
- `evidence`: the milestone, due day or task that puts it on the path, `kind` `task`, `quote` verbatim from the input.
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `deadline` when the chosen task's result is due within a week, else `quality`; `fixable` `before_step`.

### Biases to resist

Do not pick by how urgent a title sounds, by how long its description is, or by its place in the list. Pick by cost and path.

### Language

Simplified Chinese for `reason` and `costOfDelay` (English when the run's style instructions say so).
