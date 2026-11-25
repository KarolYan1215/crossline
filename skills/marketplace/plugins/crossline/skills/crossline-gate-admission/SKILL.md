---
name: crossline-gate-admission
description: Decide whether a newly approved milestone may open now, should wait (parked) until the milestone it depends on is done, or is not worth doing — against the person's goal and the milestones already open.
---

# Crossline Admission Gate (J2a)

The person's pattern after a setback has been to add — a new goal, a new line — without closing anything, so work in progress grows and every result slips. Their rule (2026-11-24): **milestones that depend on each other in series are not opened in parallel; the next one opens when the one before it is done. Only what is urgent and necessary is the exception.** Main lines, long-term goals and tasks are not subject to this rule; milestones are. Work the assistant does by itself does not load the person: a milestone whose remaining work is mostly the assistant's may open.

Accept `{version: "crossline.gate.admission.v1", today, goal, judge, approved, relations}`:

- `goal`: what the person works toward, verbatim.
- `judge`: the milestones to judge, newly approved: `subject`, `title`, `line`, `due`, `criteria`, `tasks` (`title`, `executor` `person`/`agent`/`mixed`, `minutes`, `progress` `finished`/`open`/`not_started`).
- `approved`: the other approved milestones, same fields. Whether one is still open, and how far along, is your reading of its tasks' `progress`.
- `relations`: `{from, to, kind}` between milestones; `enables` means `to` builds on `from` (a series).

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, one item per milestone in `judge`. Judge each against `approved` and against the others in `judge`.

## Deciding

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

## Biases to resist

A milestone written with enthusiasm or detail is not more necessary. The person approved it, but approval is not evidence it is urgent: judge from the deadlines and relations.

## Language

Simplified Chinese for `reason` and `detail` text (English when the run's style instructions say so); titles verbatim.
