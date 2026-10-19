---
name: crossline-background-facts
description: Silently compact one capture into structured background facts about the user's own identities — never a conversation, never a classification of the capture itself.
---

# Crossline Background Facts

Runs silently right after the person captures something (a line typed or shared into the app). Nobody waits for it and nobody talks to it. What it keeps appears under 「相关背景」 on every later task of the same line, as the fact's `value` with its `why` beneath, so a task about the same paper or client already carries what this capture said.

Accept `{version: "crossline.background-facts.v1", identities[], existingFacts[], captureTitle, captureContext}`: the person's lines (`{id, label}`), the background facts already kept (`{identityId, key, value, updatedAt}`), and the capture's own title and context. Return `{facts[], blockers[]}`; each fact carries `identityId, key, value, why, sourceQuote`.

## What is worth keeping

Something durable that many later tasks on the same line would want to know already: the title of the paper or experiment under way, a key file or repository path, the name of a client, a collaborator or a project, a fixed term of an agreement. Never the task itself, a date that only this task needs, or a passing remark.

Most captures have nothing durable in them; an empty `facts` array is the normal, successful result. You are not deciding which line the capture belongs to (that is another step); for each fact you keep, `identityId` is the line the fact is *about*.

| Capture | Keep | Not |
|---|---|---|
| 「把 MoS₂ 忆阻器那篇的图 3 重画一下，论文暂名《Hysteresis-free MoS₂ synapses》」 | `{identityId: "research", key: "current_paper_title", value: "论文暂名《Hysteresis-free MoS₂ synapses》", why: "同一篇论文的写作和改图任务都会用到这个题目", sourceQuote: "论文暂名《Hysteresis-free MoS₂ synapses》"}` | 「重画图 3」 (the task itself) |
| 「给杭州那家咖啡连锁发报价，对接人是王经理」 | `{identityId: "startup", key: "client_contact", value: "咖啡连锁客户的对接人为王经理", why: "后续报价和回访都找同一位对接人", sourceQuote: "对接人是王经理"}` | 「发报价」 |
| 「明天交作业 2」 | nothing | the due day only matters to this task |

## Rules

- `key`: short, stable, snake_case (`current_paper_title`, `main_repo_path`, `client_contact`), reused across captures: when `existingFacts` already has the key for that line, write the same key with the new value so it overwrites instead of adding a near-duplicate. Write a fact only when it is new or changed.
- `value`: one readable line in Chinese that stands on its own under 「相关背景」; names, titles and paths stay exactly as written.
- `why`: one sentence on which later work it helps.
- `sourceQuote`: an exact substring of `captureTitle` or `captureContext`, at least four characters, never a paraphrase. A quote that is not found verbatim sends the whole answer back.
- `blockers` only for something that actually prevents processing (malformed input), never to say "nothing to extract".

Allowed tools: none. Read only the supplied context; do not read or write any file, and do not call this app's own repository. Budget: low. Risk: routine, read-only compaction with no side effects beyond the structured facts it returns.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
