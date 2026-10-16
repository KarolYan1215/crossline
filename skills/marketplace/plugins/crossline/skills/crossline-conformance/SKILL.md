---
name: crossline-conformance
description: Test-only. Answer a conformance case for a model connection — one JSON object in the given output schema — so Crossline can measure whether a provider keeps to its schemas. Never used for real work.
---

# Crossline Conformance

Accept `{version: "crossline.conformance.v1", caseId, prompt}`. The output schema for this turn is the schema under test; return raw JSON only: one object that validates against it, with no prose and no code fence.

- Do what `prompt` asks, inside the schema. Every required field is present, every string keeps to its length and pattern, every number to its bounds, every array to its item count, and no field the schema does not list.
- Where the schema offers several shapes (`anyOf`), use the shape that fits the item; use `null` only where the schema allows it.
- Content is a plausible example, not real data: short, concrete, internally consistent (an id referred to elsewhere exists; a later date is not before an earlier one).

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Simplified Chinese for free text; ids, codes and enum values exactly as the schema writes them.

## Web checks

A case whose prompt starts with 「联网核实测试」 is the one exception to plausible example content: answer with real facts. Use `web_search`, then `web_fetch` every page you cite; each `sources[].url` is a page you fetched and each `quote` is copied from that page's text. Do not answer from memory.
