---
name: crossline-goal-splitter
description: Split each long-term goal a person adopted as one sentence 「成为 ___ 的<身份>」 into its independent attributes, in order, cutting only the sentence's own words, so the attributes joined again give the same sentence.
---

# Crossline Goal Splitter

A Crossline line's long-term goal is now built from attributes: the person picks several, and the goal reads 「成为 A 的、B 的<身份>」. Goals adopted before that were written as one sentence. This Skill cuts each such sentence into its attributes so it can be edited attribute by attribute; the sentence itself stays as the person wrote it.

Accept `{version: "crossline.goal-split.v1", lines}`: each line has `id`, `label` (its identity noun, e.g. 研究者, 创作者) and `goals` (the adopted sentences, the first being the one in use).

Return raw JSON only: `{lines: [{lineId, goals: [{goal, parts: [{text, kind}]}]}]}` — one entry per line given, one per goal given, with `goal` copied **exactly**.

## How to cut

- Remove the leading 「成为」 and the trailing 「的<label>」 (or the bare label); what is left is cut into attributes, **in their original order**.
- Use only the sentence's own characters. Never add, drop, reorder or reword a word. The app joins the parts as 「成为」 + 「A的、B的」… + label and compares the result with the sentence, ignoring only punctuation, spaces and 「的」; any other difference is sent back.
- An attribute is **one** independent quality: a field (`domain`: 神经形态计算方向, 科普, 半导体器件), an ability (`ability`: 能独立立项, 善于讲清复杂问题), or a lasting state (`state`: 有影响力, 持续产出, 被同行认可). Cut where one quality ends and the next begins; drop the 「的」 between them (it is added back when joining).
- No two attributes may overlap: after removing 「的」 and punctuation, neither may contain the other.
- A sentence that is one quality stays one attribute. A sentence that is not of the form 「成为 … 的<身份>」 (a dated result such as 「两年内发表两篇论文」) is returned as one attribute, the whole text.
- `kind` labels each attribute as above; when unsure between field and state, a noun phrase naming a subject is `domain`.

Example: `{id: "research", label: "研究者", goals: ["成为神经形态计算方向能独立立项的研究者"]}` → parts `[{text: "神经形态计算方向", kind: "domain"}, {text: "能独立立项", kind: "ability"}]`.

Allowed tools: none. Budget: low. Risk: routine. Evidence: the code's recomposition check.

## Language

Every human-readable field: Simplified Chinese, concise, standard register, objective third person. Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线. Text quoted from the person or a source stays verbatim.
