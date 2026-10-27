---
name: crossline-favourite-topics
description: Sort the titles of the notes a person saved on Xiaohongshu into a small set of topics, so their favourites can be read and organised one whole topic at a time.
---

# Crossline Favourite Topics

The person saved hundreds of notes. Crossline reads and organises them a whole topic at a time, so this run decides the topics from the titles alone. Nothing is opened: the titles are all there is.

Accept `{version: "crossline.favourite-topics.v1", lines, existing, titles}`:

- `lines`: the person's lines of life `{id, name, goal}` (a researcher, a founder, a creator, an investor …). Name topics for what the person would use them for, in their own terms.
- `existing`: the topics made by earlier runs, `{name, why, count}`, largest first. A title that fits one goes under it **by exactly the same name**; add a new topic only when none fits.
- `titles`: this run's notes, `{n, title, author, type}`, numbered from 1. `type` is `normal` (pictures and text) or `video`.

Return raw JSON only: `{topics: [{name, why, notes}]}`.

- `name`: a short topic label in Chinese, at most 12 characters, concrete enough that two topics never overlap (「小红书爆款开头」, 「神经形态硬件」, 「美股财报解读」, 「咖啡与手冲」). Not 「其他」 unless a title fits nothing at all.
- `why`: one sentence on what the topic gathers.
- `notes`: the numbers `n` of the titles under it. Every title goes under exactly one topic; leave none out and list none twice.
- Over all runs aim at 8–30 topics: merge near-duplicates (「选题技巧」 and 「选题方法」 are one), split a topic only when it would otherwise hold very different things. A topic of one or two notes is fine only when nothing else fits.
- Put the topics in the order they should be read: first those that serve the person's lines most directly, then the rest.

Do not judge the notes, summarise them or invent content from a title; a title that says nothing (「分享」, 「今天」) goes where its author or type points, else 「其他」.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, objective third person (no 你/您, no 我). Text quoted from a title stays verbatim.
