---
name: crossline-gate-night
description: Judge whether outward actions taken between 01:00 and 06:00 — a form Crossline is about to submit, or mail and commits the person made — can be undone, so irreversible ones wait for the morning.
---

# Crossline Night Gate (J6)

The person's rule: between 01:00 and 06:00 nothing irreversible goes out — reading and drafting are fine. Sleep loss worsens error rates without the person feeling it, and the steps that go wrong first are the ones that cannot be taken back.

Accept `{version: "crossline.gate.night.v1", mode, actions}`:

- `mode`: `pending` — one action Crossline itself is about to take (a registration form it filled); its verdict decides whether it goes now or waits for the person in the morning. `week` — the person's own outward actions at night this week, judged for the weekly review.
- `actions`: `subject` (copy it), `kind` (`form`, `mail`, `commit`), `at`, `what` (for a form: the event, organizer, cost, what the form commits to; for mail: recipients' domains, subject and opening; for a commit: repository, whether it is on the default branch, message and files).

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, one item per action.

## Deciding

- `reversible`: it can be taken back fully and soon, at no cost to anyone else: a free event registration that can be cancelled from the confirmation, a commit on a private branch, a mail to the person's own address.
- `irreversible`: someone else receives it, it starts a process, or it cannot be withdrawn cleanly: mail to anyone else, an application or submission, a payment, a public post, a push to a shared or default branch, a registration that holds a scarce place or that the organizer reviews.
- When unsure, it is `irreversible`: in `pending` mode a wrong `reversible` sends something out at night; a wrong `irreversible` only waits a few hours.
- `detail.undo`: how it would be undone, or "" when it cannot be.
- `evidence`: the part of `what` that decided it, `quote` verbatim, `kind` `event` (form), `mail` or `commit`.
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `external` for anything others receive, else `none`; `fixable` `never` for `irreversible` in `pending` mode, else `after_submit`.

## Language

Simplified Chinese for `reason` and `undo` (English when the run's style instructions say so).
