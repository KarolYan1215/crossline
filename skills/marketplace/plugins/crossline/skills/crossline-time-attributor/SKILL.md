---
name: crossline-time-attributor
description: Say which of the person's open Crossline tasks (and step) each stretch of untimed screen work was for, from its app and window titles, or none.
---

# Crossline Time Attributor

The person forgot to start the timer. Crossline drafted these stretches from the screen record (app and window titles only, nothing else captured) and could not tell from the person's rules or their calendar blocks whose time they were. Your answer is a proposal shown on the evening wrap-up as 「这些时间在做什么？」: the person confirms it, picks another task, or says it was not work. Only a confirmed stretch becomes measured time. A wrong task costs the person a correction; a stretch left unattributed costs them one pick from a list.

Accept `{version: "crossline.time-attribution.v1", tasks, stretches}`:

- `tasks`: the person's open tasks: `id`, `title`, `line` (the 主线 it belongs to) and `steps` (`id`, `title`, `kind`: the step type, such as 撰写, 阅读, 测试验证) still to do.
- `stretches`: `id`, `when` (local day and time), `minutes`, `app` (the program most of it was in), `category` (编程, 科研工具, 写作, 阅读 …) and `titles` (window titles, most time first).

Return raw JSON only: `{items: [{id, workOrderId, stepId, why}]}`, one item for every stretch, its `id` copied exactly.

## Deciding

- **A task**: `workOrderId` is the task the titles plainly name or belong to: a course code, a paper's or project's name, a file name that matches a task's title, a repository that is the task's. `stepId` is the step whose kind fits the work (a writing app → a 撰写 or 修订 step; a simulator → a 测试验证 step), or "" when no one step clearly fits.
- **None**: `workOrderId: ""`, `stepId: ""` when the titles name nothing in the tasks, name several tasks equally, or are generic (「新建标签页」「Untitled」「Downloads」). Never pick a task because it is the only one on a line or because the category matches; a title has to tie it.
- `why`: one short clause quoting what in the titles decided it, or what is missing.
- Never invent an id; only ids from `tasks` and their `steps`.

| Stretch | Answer | `why` |
|---|---|---|
| 40 min in WINWORD, titles 「ECE555_HW3.docx」, task 「完成 ECE 555 作业 3」 | that task, its 撰写 step if one is open | 「标题中的 ECE555_HW3 对应作业 3」 |
| 25 min in Code, titles 「crossline – timer.ts」, no task names crossline | "" | 「标题只有仓库名，任务中无对应项」 |
| 30 min in chrome, titles 「Overleaf – NeurIPS draft」, tasks 「NeurIPS 论文初稿」 and 「ICML 审稿」 | the NeurIPS task | 「Overleaf 项目名为 NeurIPS draft」 |

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. Quotes from the titles stay verbatim; ids stay exactly as given.

`why` in Simplified Chinese, concise, objective third person.
