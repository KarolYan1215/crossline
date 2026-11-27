---
name: crossline-weekly-review
description: Looking back at a week: where the measured time went and whether meta-work crowded out P1 outside gates (`attention`, gate J5), what a setback says (`setback`, gate J6), and the few patterns the week's record supports (`insight`). The input's `mode` says which.
---

# Crossline weekly review

Looking back at a week: where the measured time went and whether meta-work crowded out P1 outside gates (`attention`, gate J5), what a setback says (`setback`, gate J6), and the few patterns the week's record supports (`insight`).

Every run's input carries `mode`: `attention` (The week's attention audit), `setback` (A setback), `insight` (The week's patterns). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "attention"` — The week's attention audit (J5)

Sort a week of the person's measured time into execution, outside gates, meta-work and other — with Crossline's own development on its own line — and judge whether this week's P1 outside gates were crowded out by meta-work.

The person's diagnosis: time goes to work they judge themselves (planning, modelling themselves, building tools such as Crossline) while the cheap outside gates on the path to their results wait. This audit measures where the week actually went.

Accept `{version: "crossline.gate.attention.v1", weekStart, weekEnd, goal, p1, blocks}`:

- `p1`: P1 and outward tasks with what the completion gate last found (`done`, `submitted`, `waiting`, `planned`, or `not_judged`) and their due day.
- `blocks`: measured stretches, each `id`, `start`, `end`, `minutes`, `source` (`screen`: an app and its window title — titles of private material arrive masked as 「[仅本地]」; `agent`: a Claude Code or Codex session and its working folder; `commit`: a commit, its repository and message, 0 minutes; `timer`: time the person timed on a task), and `text`. Stretches of the same thing on one day are already joined, and overlaps are already removed (a minute counts once: timer before agent before screen) — do not discount them again.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, one item with `subject` `week`.

### Sorting

Put every block in one class, from its title, folder, repository or task — not from the app alone (a browser can be a paper or a video):

- `execution`: the work itself — the paper, experiments and simulation, coursework, design work.
- `outside_gate`: handing work to others or unblocking it: applications, mail to an advisor or office, sending a draft, administrative mail.
- `meta`: work about the work — planning, self-analysis and modelling, research-rule upkeep, and **building Crossline itself** (the repository `Multi-ID` or `crossline`, the Crossline app's own settings).
- `other`: everything else, including what cannot be told (a masked title alone). Say in `detail.unclear` how many minutes were unclear and why.

`detail.classes`: one entry per block, `{id, class, crossline}` — `crossline` true for Crossline's own development (also `meta`). Every block id appears once. The hours per class are summed from these by the caller; you weigh them for the verdict, but do not report totals.

`detail.unclear`: one sentence on how much was unclear and why ("" when nothing was).

### The judgement

`verdict`: `crowded_out` when P1 outside gates stayed `planned` this week while meta-work took time that could have closed them (cite both the P1 and the meta blocks); `not_crowded` when the P1 gates closed or the meta time was small or could not have been used for them; `cannot_judge` when there are no P1 or no measured time.

The person's own target, a goal description and not a hard line: planning, review and self-analysis about a tenth of the week or less; Crossline development about two hours a week or less. Mention in `reason` how far the week is from it.

- `evidence`: the blocks and P1 that decided it, `quote` verbatim from their `text`.
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `quality`; `fixable` `before_step`.

### Biases to resist

Do not count a block as execution because its title sounds like work; check the folder or repository. Do not soften the verdict because the week was long.

### Language

Simplified Chinese for `reason` and `detail.unclear` (English when the run's style instructions say so).

## `mode: "setback"` — A setback (J6)

Classify a setback — a rejection, a missed milestone, or one the person reports — as a wrong goal, a wrong execution, or noise, using base rates, and say what (if anything) should change.

The person's own protocol (12 §2): after a setback, first classify, then change only what the class calls for.

- **goal_wrong** — the goal itself is out of reach or not worth it. Then change the goal, one for one: a new line only by closing one.
- **execution_wrong** — the goal is fine, the way it was pursued failed (a beginner's mistake in a risky step, a late start, a missing check). Change the method; keep the goal.
- **noise** — the outcome is mostly chance or base rate: one rejection where acceptance rates are low says almost nothing about the goal. Change nothing; continue.

Their history: three times a setback was followed by a larger goal and more lines within a week. That reaction fits only `goal_wrong`. In the 72 hours after a setback, judgement is worse (mood shifts risk preferences), so you classify and the person decides.

Accept `{version: "crossline.gate.setback.v1", today, goal, setbacks, outcomes, milestones}`:

- `setbacks`: each one to classify: `subject`, `kind` (`rejected` application or opportunity, `missed` milestone, `reported` by the person), `title`, `at`, `what` (the outcome as recorded; for `reported`, the person's own words), `line` (the line it belongs to, or null).
- `outcomes`: every recorded outcome of an application or registration (`at`, `outcome`, `kind`, `line`, `title`, `organizer`). Pick out the tries similar to each setback yourself and use them as the person's own base rate.
- `milestones`: the current milestones, for context.

You may search the web for base rates (acceptance rates of the venue or program, interview-to-offer rates for the kind of role). Cite each figure in `evidence` with `kind` `web`, the URL in `ref` and the sentence in `quote`; say when no figure could be found.

Return raw JSON only: `{items: [{subject, verdict, confidence, evidence, reason, ifWrong, detail}]}`, one item per setback.

### Deciding

1. What does the outcome tell about the goal, given the base rate? One rejection at a 10% acceptance rate is expected; ten in a row at that rate is information.
2. Is there an identifiable execution cause in the record (late, incomplete, a skipped check, a wrong assumption)? Then `execution_wrong`, naming it.
3. `goal_wrong` needs evidence that the goal is unreachable or not worth it — a closed door, a requirement the person cannot meet, a value that changed — not just a failure.
4. When the evidence cannot separate the classes, prefer `noise` over `goal_wrong` and say what would decide it.

- `detail.change`: for `goal_wrong`, the goal to replace and with what, and which line closes in exchange; for `execution_wrong`, the method to change; for `noise`, 「不改，继续」.
- `detail.baseRate`: the figure used and its source, or "未找到".
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `quality` (`deadline` when a wrong `goal_wrong` would drop work due soon); `fixable` `before_step`.

### Biases to resist

The person's words after a setback may be dramatic; weigh what happened, not how it is told. Do not agree with a self-assessment because it is confident.

### Language

Simplified Chinese for `reason` and `detail` text (English when the run's style instructions say so).

## `mode: "insight"` — The week's patterns

Read one week of the person's Crossline execution record and propose the few patterns the data supports, each with its supporting and contrary events and one suggestion the person can act on.

On the weekly review page (/review, 「本周洞察提案」) the person reads each insight as a bold claim, its period and observation count, and 「建议：」 followed by your suggestion. Nothing is changed automatically: the person decides whether to act on it. A wrong insight costs the person's trust in every later one, so propose only what the record supports.

### Input `crossline.weekly-insight.v1`

- `period` — `{from, to}`, the last seven days.
- `executions[]` — `{id, workOrderId, identityId, family, startedAt, endedAt, pauseMinutes, durationObserved}`: timed work sessions.
- `estimates[]` — `{workOrderId, identityId, family, p50Minutes}`: what each task was estimated at.
- `energyObservations[]` — `{id, level, observedAt}`: the person's energy self-reports.
- `notificationEvents[]` — `{id, type, entityId, createdAt}`: state changes, materials that stopped, gate judgements.
- `byproducts` — `{planned, landed, missed, items[]}`: what one line's work also produced for another this week.
- `approvedMilestones[]` — `{id, identityId, title}`.

Return raw JSON only: `{insightProposals[], estimateUpdates[], retentionActions[], blockers[]}`.

### Insight proposals

Each `{id, claim, observationCount, period, supportingEventIds[], counterexampleEventIds[], proposedOverlayPatch}`:

- `claim` — one sentence stating the pattern with its figures.
- `observationCount` — how many comparable observations it rests on, **at least three**. A pattern with fewer is not proposed at all.
- `supportingEventIds` and `counterexampleEventIds` — ids copied from `executions[].id` or `notificationEvents[].id` only (energy observation ids are not accepted). Name the contrary cases honestly; a claim with no counterexample looked for is weaker, not stronger.
- `period` — the span it covers, readable: 「10/12–10/19」.
- `proposedOverlayPatch` — one concrete suggestion in words, shown after 「建议：」: what to change (an estimate, a time slot, a line's share) and to what.

Keep apart what is not the person's ability: an interruption, a missing input and an estimation error are three different findings, and none of them says the person is slow.

| | claim / 建议 |
|---|---|
| 好 | 「本周 4 次复习类计时中有 3 次超出估时 40% 以上」 / 「复习类任务的通常时长按 1.4 倍估」 |
| 好 | 「5 次晚间 21 点后的计时有 4 次中途暂停超过 15 分钟」 / 「深度工作不再排在 21 点以后」 |
| 坏 | 「本人效率不高」 (a judgement of the person, no figure) |
| 坏 | 「周三状态不好」 from one session (fewer than three observations) |

`byproducts`: report them in an insight when at least three were planned; when one kind kept being missed, say which kind and what the data suggests.

### Other fields

- `estimateUpdates[]` — `{identityId, family, suggestedP50Minutes, rationale}` where at least three finished sessions of one line and kind disagree with their estimates in the same direction.
- `retentionActions[]` — usually empty; `{action: keep|archive, targetId, reason}` only for an earlier insight the week's record clearly confirms or contradicts.
- `blockers[]` — a blocker discards the whole run, so use one only when nothing in the week can be read at all. A week without a strong pattern returns empty lists, not a blocker.

Allowed tools: supplied structured history only. Budget: standard. Risk: milestone.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
