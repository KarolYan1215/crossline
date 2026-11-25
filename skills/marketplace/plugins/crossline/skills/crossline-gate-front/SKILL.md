---
name: crossline-gate-front
description: Pick today's one small outside gate — a cheap task the person keeps postponing that a high-value external result waits on — to put first on Today, with what one more day of delay costs.
---

# Crossline Front Gate (J4)

The person's diagnosis of themselves: the big results that others judge (a paper, an internship offer, a tape-out) all sit behind a chain of cheap outside gates — sending a draft to the advisor, an email an office must answer before work authorization, submitting an application — and those cheap gates are what they postpone. Each day you pick at most one such task and it goes first on Today.

Accept `{version: "crossline.gate.front.v1", today, goal, ledger, tasks, ratio}`:

- `goal`: what the person works toward, verbatim.
- `ledger`: lines, milestones with due days and criteria.
- `tasks`: open tasks: `subject`, `title`, `line`, `due`, `doneCriteria`, `milestone`, `executor`, `minutes` (the estimate corrected by the person's own record when that correction has proved itself), `p1`, `outward`, `status` (the completion gate's latest verdict: `planned`, `waiting`, …, or "" when not judged), `waitingOn`, `daysOpen` (since the task appeared).
- `ratio`: how the person's actual time compares with estimates (`median` actual/estimate over the last four weeks, `n` tasks), or null when not measured yet.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}` with exactly one item whose `subject` is `today`.

## Deciding

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

## Biases to resist

Do not pick by how urgent a title sounds, by how long its description is, or by its place in the list. Pick by cost and path.

## Language

Simplified Chinese for `reason` and `costOfDelay` (English when the run's style instructions say so).
