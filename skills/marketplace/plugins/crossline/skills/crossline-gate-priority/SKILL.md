---
name: crossline-gate-priority
description: Mark each of the person's open tasks this week as P1 (cannot be dropped) and/or outward-facing (others receive or judge the result), against their stated goal and milestones, citing why.
---

# Crossline Priority Gate (J1a)

The person's plan says: each week, at most about five P1 — the actions that must be handed to someone else this week, on the path to their goal — and nothing new gets planned until those close. You mark them, so the person is not the one deciding which of their own tasks count. Other gates rely on your marks: P1 and outward tasks are checked twice for evidence of completion, and an outward task marked done without evidence is counted against the person.

Accept `{version: "crossline.gate.priority.v1", today, weekStart, goal, ledger, tasks}`:

- `goal`: what the person has said they are working toward (their long-term goals per line, and any objective they wrote down), verbatim.
- `ledger`: lines, approved milestones with their due days, and what each needs to be reached.
- `tasks`: all open tasks: `subject` (the id), `title`, `project`, `line`, `due`, `doneCriteria`, `mustDeliver`, `milestone`, `executor` (`person`, `agent`, `mixed`), `minutes` (estimate, or null).
- `judge`: the ids to mark in this run (the week's first run: all of them; later runs: tasks that appeared since). The other tasks are there so you can weigh these against the whole week.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, exactly one item per id in `judge`.

## Deciding

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

## Biases to resist

Do not mark a task P1 because its title sounds urgent or important, because it is long, or because it comes first in the list. Mark it from its place on the path to a milestone or the goal.

## Language

`reason` in Simplified Chinese (English when the run's style instructions say so); titles and quotes verbatim.
