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

Simplified Chinese for free text; ids, codes and enum values exactly as the schema writes them.
