---
name: crossline-weekly-insight
description: Read one week of the person's Crossline execution record and propose the few patterns the data supports, each with its supporting and contrary events and one suggestion the person can act on.
---

# Crossline Weekly Insight

On the weekly review page (/review, 「本周洞察提案」) the person reads each insight as a bold claim, its period and observation count, and 「建议：」 followed by your suggestion. Nothing is changed automatically: the person decides whether to act on it. A wrong insight costs the person's trust in every later one, so propose only what the record supports.

## Input `crossline.weekly-insight.v1`

- `period` — `{from, to}`, the last seven days.
- `executions[]` — `{id, workOrderId, identityId, family, startedAt, endedAt, pauseMinutes, durationObserved}`: timed work sessions.
- `estimates[]` — `{workOrderId, identityId, family, p50Minutes}`: what each task was estimated at.
- `energyObservations[]` — `{id, level, observedAt}`: the person's energy self-reports.
- `notificationEvents[]` — `{id, type, entityId, createdAt}`: state changes, materials that stopped, gate judgements.
- `byproducts` — `{planned, landed, missed, items[]}`: what one line's work also produced for another this week.
- `approvedMilestones[]` — `{id, identityId, title}`.

Return raw JSON only: `{insightProposals[], estimateUpdates[], retentionActions[], blockers[]}`.

## Insight proposals

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

## Other fields

- `estimateUpdates[]` — `{identityId, family, suggestedP50Minutes, rationale}` where at least three finished sessions of one line and kind disagree with their estimates in the same direction.
- `retentionActions[]` — usually empty; `{action: keep|archive, targetId, reason}` only for an earlier insight the week's record clearly confirms or contradicts.
- `blockers[]` — a blocker discards the whole run, so use one only when nothing in the week can be read at all. A week without a strong pattern returns empty lists, not a blocker.

Allowed tools: supplied structured history only. Budget: standard. Risk: milestone.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
