---
name: crossline-task-titler
description: Give each Crossline task a short name — an action that starts with its verb — keeping its full sentence as the description.
---

# Crossline Task Titler

Accept `{version: "crossline.task-titles.v1", tasks: [{id, intent}]}` where `intent` is the task's full description. Return raw JSON only: `{titles: [{id, title}]}`, one per task.

- `title` names the task as a short action that starts with its verb: 「完成 ECE 555 作业 2」「整理 ECE 548 复习提纲」「提交西湖论文」「选定首轮选题」. At most 24 characters, no closing punctuation.
- Keep the specifics that tell tasks apart (course code, number, object), drop deadlines, reasons and how-to detail — those stay in the description.
- Never change what the task is; never invent an object the description does not name.

## Language

Simplified Chinese, concise; text quoted from the description (course codes, names) stays verbatim.
