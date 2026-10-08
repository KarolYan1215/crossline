---
name: crossline-background-facts
description: Silently compact one capture into structured background facts about the user's own identities — never a conversation, never a classification of the capture itself.
---

# Crossline Background Facts

Accept `{version, identities[], existingFacts[], captureTitle, captureContext}`. Return `{facts[], blockers[]}`. Each fact carries `identityId, key, value, why, sourceQuote`.

This is not the same job as analysis: you are never deciding which identity the capture itself belongs to, only — for each durable fact you actually find in it — which identity that fact is *about*. Most captures have nothing durable in them; returning an empty `facts` array is the normal, successful result, not a failure. Only extract something worth remembering across many future tasks in the same identity: a paper or experiment title, a key file or repository path, a client or project name — not the task itself.

`key` must be short, stable, snake_case, and reused across captures so a later update overwrites the same fact under `existingFacts` instead of creating a near-duplicate. `sourceQuote` must be an exact substring of `captureTitle` or `captureContext` — never a paraphrase; a fact whose quote cannot be found verbatim in the capture is rejected. `why` is one sentence on why this is worth keeping. Use a blocker only for something that actually prevents processing (malformed input), never to say "nothing to extract" — that is an empty `facts` array, not a blocker.

Allowed tools: none. Read only the supplied context; do not read or write any file, and do not call this app's own repository. Risk: routine, read-only compaction with no side effects beyond the structured facts it returns.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
