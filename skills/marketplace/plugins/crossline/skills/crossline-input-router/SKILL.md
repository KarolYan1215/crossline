---
name: crossline-input-router
description: Read what was typed into quick capture and split it into new items to capture and instructions about already planned tasks (move a due date, change a duration, start later).
---

# Crossline Input Router

Input is `crossline.input-route.v1`: `text` (what the person typed), `batch` (true when they chose batch input), `today` and `timeZone`, `openTasks` (id, title, line, project, due date, current usual minutes), `mentions` (tasks, milestones or materials they linked with @) and `recentOps` (the person's own operations of the last 24 hours, newest first: `id`, `label` such as 「不等了：西湖 MoS2 真实测量数据」, `at`). Return raw JSON only: `{items}`.

- An **instruction about an open task** becomes `{kind: "schedule", workOrderId, change, summary}`:
  - `change.type` `due`: a new latest-finish day (`date` = YYYY-MM-DD);
  - `defer`: not before a day (`date`), the work moves later;
  - `estimate`: a new usual duration in minutes (`minutes`), e.g. 「多给一小时」 = current + 60.
  - Resolve relative dates (周五, 下周一, 明天) against `today` in `timeZone`. Pick the task by its title, project or a mention; if no open task clearly matches, make it a capture instead.
  - `summary`: one line saying the change (「ECE 555 作业 2 截止改为 10/16」). Other fields `""`/`0`.
- **Taking back something just done** (「撤销刚刚的不等了」, 「刚才点错了，恢复那个任务」, 「撤回上一步」) becomes `{kind: "undo", opId, summary}`: `opId` is the `recentOps` entry it refers to — match by what the label says (an answer such as 不等了/到了/明天再问, an action such as 归档/丢弃/批准/修改时长, the task's words), and when it says only 「刚才/上一步」 take the newest. If none matches, `opId` is `""`. `summary` says what is taken back. An undo is never a capture: it is not new work. Other fields `""`/`0`, `change.type` `"none"`.
- **Anything else** becomes `{kind: "capture", title, context}`: new work, an idea, a note. In batch mode split the text into separate items — one per distinct piece of work, not one per line; keep the person's wording in `title`, put supporting detail in `context`. Without batch, one capture unless the text is clearly several things.
- Never invent tasks, dates or numbers that are not in the text. Unused fields are `""` and `0`, `change.type` `"none"` for a capture, `opId` `""` for anything but an undo.

Chinese, objective, third person.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
