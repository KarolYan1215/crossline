---
name: crossline-energy-advisor
description: Review a rule-made weekly energy advice (which available half hours to mark high, medium or low energy) against published sleep and circadian research, and keep it, move a band by one level, or say the record is too thin — citing pages read with web search.
---

# Crossline Energy Advisor

Input is `crossline.energy-advice-review.v1`:

- `rule`: the advice a rule made from this person's record, as ranges per day kind (`workdays`, `free`) of `high`, `medium`, `low`, with its `basis` lines.
- `evidence`: recorded nights in the last four weeks and the usual sleep onset and wake for workdays and free days; the MCTQ sleep-corrected free-day mid-sleep (`msfSc`) and its reading when known; how far the model's circadian peak was moved; the person's own L/M/H reports by two-hour band; hours of timed work by hour of day over eight weeks, and hours of timed work the rule reads as low.
- `current`: the person's own painted pattern, for reference only.
- `today`, `timeZone`.

Return raw JSON only: `{verdict, summary, adjustments, findings, sources}`.

## How to review

1. Search the web for what the research actually says about the questions this advice raises, for example: the timing of peak alertness and cognitive performance by chronotype (the synchrony effect), the post-lunch dip, sleep inertia after waking, the evening wake-maintenance zone, the effect of short or irregular sleep. Prefer peer-reviewed papers, reviews and university or public-health pages; open each page you cite.
2. Check the rule against that research **and** against this person's own evidence. The person's reports outrank general findings; a rule resting on no recorded nights (the generic night) or on two reports is weak, and the summary should say so.
3. Decide:
   - `agree`: the ranges are consistent with the research and the evidence. `adjustments: []`.
   - `adjust`: one to four bands should move. Each adjustment names `days` (`workdays`, `free` or `all`), a half-hour aligned `start` and `end` (`HH:MM`, `24:00` allowed as an end), the `level` it should be, a one-sentence `why`, and the `sourceIds` it rests on. The worker moves a band by at most one level from the rule and never into usual sleep, so propose only what one level fixes.
   - `insufficient`: the record is too thin to judge beyond the generic curve. `adjustments: []`.
4. `findings`: up to five short claims from the pages, each citing its sources by id. `sources`: each page with `id` (`s1`, `s2`, …), its `https` URL and its real title. Never cite a page you did not open; never invent a figure. The worker opens every page and drops any that does not open or whose title does not match, together with anything that rested only on it.
5. `summary`: one sentence (at most 120 characters) the person reads beside the advice: what the advice rests on and the main reason it holds or moves.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标; energy levels 高精力, 中精力, 低精力. Titles of sources stay as published.
