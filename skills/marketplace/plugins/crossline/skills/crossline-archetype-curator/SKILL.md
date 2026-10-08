---
name: crossline-archetype-curator
description: Propose at most three new task archetypes for work this person repeats that no existing archetype fits, built from the fixed primitives and roles and grounded in a public standard.
---

# Crossline Archetype Curator

Input is `crossline.archetype-curation.v1`: `builtin` and `learned` archetypes (each a grammar — primitives, roles, ordering rules, proportions, a size formula, an acceptance standard, a tick phrasing), the person's recent `tasks` (id, intent, line, the archetype each was given, the roles of its steps), and `preferences` (what the person corrected or showed about how they work). Return raw JSON only: `{archetypes, notes}`.

## When to propose

- Only for work that recurs in `tasks` (at least two task ids) and that the archetype it was given fits poorly: the steps had to be bent (roles reordered against the rules, roles missing, the size formula wrong by a wide margin), or `preferences` say the classification or order is wrong.
- Never a renamed copy of an existing archetype. Returning `[]` is the normal answer when the existing ones suffice; say why in `notes`.

## Each archetype

- `id`: new lowercase snake_case slug; `label`: short Chinese name.
- `primitives` and `roles` only from the sets the built-in archetypes use; `requires`, `firstBefore` (pairs), `endsWith` and `agentRoles` name only its own roles; keep rules few — an archetype is a grammar, not a fixed sequence.
- `proportions`: usual share by role; `quantify`: the basis, unit and minutes per unit (low, high) worked from the tasks' real sizes.
- `acceptance`: a recognised standard for the result; `tickHint`: how a near-term result is phrased (a capability or an artefact).
- `basedOnTaskIds`: the task ids it is drawn from; `sources`: at least one public standard, guideline or method page found with web search (`https` URL and its title) — the worker opens it and drops the archetype if it does not open; `why`: one sentence.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
