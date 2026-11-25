---
name: crossline-gate-attention
description: Sort a week of the person's measured time into execution, outside gates, meta-work and other — with Crossline's own development on its own line — and judge whether this week's P1 outside gates were crowded out by meta-work.
---

# Crossline Attention Audit (J3)

The person's diagnosis: time goes to work they judge themselves (planning, modelling themselves, building tools such as Crossline) while the cheap outside gates on the path to their results wait. This audit measures where the week actually went.

Accept `{version: "crossline.gate.attention.v1", weekStart, weekEnd, goal, p1, blocks}`:

- `p1`: P1 and outward tasks with what the completion gate last found (`done`, `submitted`, `waiting`, `planned`, or `not_judged`) and their due day.
- `blocks`: measured stretches, each `id`, `start`, `end`, `minutes`, `source` (`screen`: an app and its window title — titles of private material arrive masked as 「[仅本地]」; `agent`: a Claude Code or Codex session and its working folder; `commit`: a commit, its repository and message, 0 minutes; `timer`: time the person timed on a task), and `text`. Stretches of the same thing on one day are already joined, and overlaps are already removed (a minute counts once: timer before agent before screen) — do not discount them again.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, one item with `subject` `week`.

## Sorting

Put every block in one class, from its title, folder, repository or task — not from the app alone (a browser can be a paper or a video):

- `execution`: the work itself — the paper, experiments and simulation, coursework, design work.
- `outside_gate`: handing work to others or unblocking it: applications, mail to an advisor or office, sending a draft, administrative mail.
- `meta`: work about the work — planning, self-analysis and modelling, research-rule upkeep, and **building Crossline itself** (the repository `Multi-ID` or `crossline`, the Crossline app's own settings).
- `other`: everything else, including what cannot be told (a masked title alone). Say in `detail.unclear` how many minutes were unclear and why.

`detail.classes`: one entry per block, `{id, class, crossline}` — `crossline` true for Crossline's own development (also `meta`). Every block id appears once. The hours per class are summed from these by the caller; you weigh them for the verdict, but do not report totals.

`detail.unclear`: one sentence on how much was unclear and why ("" when nothing was).

## The judgement

`verdict`: `crowded_out` when P1 outside gates stayed `planned` this week while meta-work took time that could have closed them (cite both the P1 and the meta blocks); `not_crowded` when the P1 gates closed or the meta time was small or could not have been used for them; `cannot_judge` when there are no P1 or no measured time.

The person's own target, a goal description and not a hard line: planning, review and self-analysis about a tenth of the week or less; Crossline development about two hours a week or less. Mention in `reason` how far the week is from it.

- `evidence`: the blocks and P1 that decided it, `quote` verbatim from their `text`.
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `quality`; `fixable` `before_step`.

## Biases to resist

Do not count a block as execution because its title sounds like work; check the folder or repository. Do not soften the verdict because the week was long.

## Language

Simplified Chinese for `reason` and `detail.unclear` (English when the run's style instructions say so).
