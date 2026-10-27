---
name: crossline-goal-splitter
description: Split each long-term goal a person adopted as one sentence 「成为 ___ 的<身份>」 into its independent attributes, in order, cutting only the sentence's own words, so the attributes joined again give the same sentence.
---

# Crossline Goal Splitter

A Crossline line's long-term goal is built from attributes: the person picks several chips on the line's card, and the goal reads 「成为 A 的、B 的<身份>」. Goals adopted before that were written as one sentence, and some lines still carry the interview's old whole-sentence suggestions. This Skill cuts each such sentence into its attributes so the person can edit the goal attribute by attribute. Nobody reads your answer as text: the app checks it, stores the parts as chips and shows the sentence exactly as before.

Accept `{version: "crossline.goal-split.v1", lines}`: each line has `id`, `label` (its identity noun, e.g. 研究者, 创作者) and `goals` (the sentences to cut, the first being the one in use).

Return raw JSON only: `{lines: [{lineId, goals: [{goal, parts: [{text, kind}]}]}]}`, one entry per line given and one per goal given, with `goal` copied **exactly**.

## How to cut

- Remove the leading 「成为」 and the trailing 「的<label>」 (or the bare label); what is left is cut into attributes, **in their original order**.
- Use only the sentence's own characters. Never add, drop, reorder or reword a word, even when a part reads like an action (「能独立立项」 stays 「能独立立项」): the sentence is the person's, and the card shows it as they wrote it. The app joins the parts as 「成为」 + 「A的、B的」… + label and compares the result with the sentence, ignoring only punctuation, spaces and 「的」; any other difference is sent back.
- An attribute is **one** independent quality. Cut where one quality ends and the next begins, usually at a 「的」 or between a field and what is said about the person; drop the 「的」 between them (joining adds it back).
- No two attributes may overlap: after removing 「的」 and punctuation, neither may contain the other.
- A sentence that is one quality stays one attribute. A sentence that is not of the form 「成为 … 的<身份>」 (a dated result such as 「两年内发表两篇论文」) is returned as one attribute, the whole text.
- `kind`: `domain` for a field (神经形态计算方向, 科普, 半导体器件), `ability` for how they work (严谨, 高产, 独立, 能独立立项), `state` for a lasting standing or condition (有影响力, 值得信赖, 被同行认可, 稳定更新). When unsure between field and state, a noun phrase naming a subject is `domain`.

## Examples

- `{id: "research", label: "研究者", goals: ["成为神经形态计算方向能独立立项的研究者"]}` → `[{text: "神经形态计算方向", kind: "domain"}, {text: "能独立立项", kind: "ability"}]`.
- `{id: "media", label: "创作者", goals: ["成为有影响力的科普创作者"]}` → `[{text: "有影响力", kind: "state"}, {text: "科普", kind: "domain"}]`. Not `[{text: "影响力大"}, …]`: reworded, so it never recomposes.
- `{id: "research", label: "研究者", goals: ["成为严谨、高产的研究者"]}` → `[{text: "严谨", kind: "ability"}, {text: "高产", kind: "ability"}]`.

Allowed tools: none. Budget: low. Risk: routine. Evidence: the code's recomposition check.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard register, objective third person. Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线. Text quoted from the person or a source stays verbatim.
