---
name: crossline-gate-setback
description: Classify a setback — a rejection, a missed milestone, or one the person reports — as a wrong goal, a wrong execution, or noise, using base rates, and say what (if anything) should change.
---

# Crossline Setback Gate (J2b)

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

## Deciding

1. What does the outcome tell about the goal, given the base rate? One rejection at a 10% acceptance rate is expected; ten in a row at that rate is information.
2. Is there an identifiable execution cause in the record (late, incomplete, a skipped check, a wrong assumption)? Then `execution_wrong`, naming it.
3. `goal_wrong` needs evidence that the goal is unreachable or not worth it — a closed door, a requirement the person cannot meet, a value that changed — not just a failure.
4. When the evidence cannot separate the classes, prefer `noise` over `goal_wrong` and say what would decide it.

- `detail.change`: for `goal_wrong`, the goal to replace and with what, and which line closes in exchange; for `execution_wrong`, the method to change; for `noise`, 「不改，继续」.
- `detail.baseRate`: the figure used and its source, or "未找到".
- `reason`: one sentence in Simplified Chinese.
- `ifWrong`: `harm` `quality` (`deadline` when a wrong `goal_wrong` would drop work due soon); `fixable` `before_step`.

## Biases to resist

The person's words after a setback may be dramatic; weigh what happened, not how it is told. Do not agree with a self-assessment because it is confident.

## Language

Simplified Chinese for `reason` and `detail` text (English when the run's style instructions say so).
