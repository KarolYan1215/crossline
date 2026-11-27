---
name: crossline-line-filer
description: Filing what the person has under their lines: calendar events (`calendar`), authorized folders and files (`folder`), and stretches of untimed screen work (`time`). The input's `mode` says which.
---

# Crossline line filer

Filing what the person has under their lines: calendar events (`calendar`), authorized folders and files (`folder`), and stretches of untimed screen work (`time`).

Every run's input carries `mode`: `calendar` (Calendar events), `folder` (Folders and files), `time` (Untimed screen work). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "calendar"` — Calendar events

File each of the person's calendar events under one of their Crossline lines, or under none, from the event's title and timing.

The answer colours the person's day, week and month views: an event filed under a line takes that line's colour, one filed under none stays grey, and one marked unclear is asked about on 待确认 (the person's answer is final and never refiled). A wrong colour misleads every view of the week; a question costs one click.

Accept `{version: "crossline.calendar-lines.v2", lines, projects, files, facts, events}`:

- `lines`: the person's 主线: `id`, `label` (an identity noun such as 研究者), `hard` (a line whose fixed schedule, such as classes, is the backbone of the week), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: `{name, lineId}`: course codes, papers, products, channels, and the line each belongs to.
- `files`: the person's uploaded files by `name`, with the `project` each is filed under ("" when none).
- `facts`: what the person confirmed (`lineId`, `project`, `statement`): fixed meetings, courses taken, collaborators.
- `events`: one entry per distinct title: `key`, `title`, `source` (`calendar` = their synced calendar, `file` = a date confirmed from their files), `count` (occurrences on the plan) and up to three `when` examples (date, weekday, time).

Return raw JSON only: `{items: [{key, lineId, why, unclear, rest, cancelled}]}`, one item for every event, with its `key` copied exactly. Read everything before deciding: the title, its timing and recurrence, the projects, the files and the facts (a fact saying 「每周二组会」 places a Tuesday 「Meeting」; a weekly slot matching a hard line's class times belongs to that line).

### Deciding

- **A line**: `lineId` is the line the event serves, `unclear: false`. A course's lecture, lab, office hour or exam → the line holding that course's project; a group meeting, advisor 1:1 or seminar → the line whose description covers research; investor, customer or product meetings → the line that covers building a company; recording, publishing or audience events → the line that covers making content; market events → the line that covers investing. Go by the lines' descriptions and projects, not by these example kinds. An event that touches two lines goes to the one its title or project names.
- **None**: `lineId: ""`, `unclear: false`, when the event plainly serves none of the lines: personal errands, health appointments, social plans, holidays, birthdays, travel.
- **Unclear**: `lineId: ""`, `unclear: true`, when nothing given tells which line it serves (「Busy」「Hold」「Meeting」 with no fact, file or timing that places it). Never guess a line to avoid asking. `unclear` is true only with an empty `lineId`.

| Event | Answer | `why` |
|---|---|---|
| 「ECE 555 Lecture」, Tue/Thu 09:30, project ECE 555 on the 研究者 line | that line's id | 「ECE 555 为研究者主线下的课程」 |
| 「Meeting」 every Tuesday 14:00, fact 「每周二下午固定组会」 on the 研究者 line | that line's id | 「事实记录每周二固定组会」 |
| 「Dentist」 | "" | 「个人就医，不属于任何主线」 |
| 「Hold」 once, no fact or file mentions it | "", unclear | 「标题未说明内容，也无相关记录」 |

### Marks

Two more answers per event, independent of its line. No word list in the app makes these calls any more; yours are the only ones.

- `rest`: `true` when the event is rest rather than a commitment — a break, a meal, sleep, 「休息」「不排工作」「勿扰」, a block the person set to keep work off their evening. It still keeps work off those hours; it is only not counted as fixed schedule, and the evening wrap-up takes the working day as ending where it begins. A seminar, meeting or class held over a meal (「Lunch Seminar」「Dinner with advisor」) is attended, so `false`.
- `cancelled`: `true` when the title says the organiser cancelled it (「Canceled: Group Meeting」「已取消：组会」). The plan then does not block that time for it. `false` otherwise.

| Event | `rest` | `cancelled` |
|---|---|---|
| 「休息」 21:00–23:59 | true | false |
| 「Lunch」 12:00–13:00 daily | true | false |
| 「Lunch Seminar」 | false | false |
| 「Canceled: ECE 555 Office Hours」 | false | true |

- `why`: one short clause naming what decided it, or for an unclear one, what is missing.
- Never invent a line id; never merge or split events.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`why` in Simplified Chinese, concise, objective third person; titles and codes quoted verbatim.

## `mode: "folder"` — Folders and files

Decide which of the person's Crossline lines each folder they authorized serves — one, several or none — from the folder's name, its file names and the openings of a few files; and screen a folder the person picked for upload, keeping the files worth reading by name, format, size and date; and file a read file under the one known project it belongs to, or none.

Three jobs on the person's folders and files, told apart by `version`.

### Filing folders under lines (`crossline.folder-lines.v1`)

The answer decides whose material a folder is: when a task has few files of its own, its step plan is given the files of the folders filed under the task's line, so a folder filed under the 研究者 line lends its notes and drafts to that line's tasks. The person sees the result on the folder's card and can change it; their choice is never replaced.

Accept `{version: "crossline.folder-lines.v1", lines, projects, folders}`:

- `lines`: the person's 主线: `id`, `label` (an identity noun such as 研究者), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: `{name, lineId}`: papers, products, clients, channels, courses, and the line each belongs to.
- `folders`: each folder the person authorized: `id`, `name` (the folder's own name), `files` (up to forty relative file names inside it) and `openings` (`{name, text}`: the first few hundred characters of up to four of its files; often empty, since a folder is read only when needed).

Return raw JSON only: `{folders: [{id, lineIds, why}]}`, one entry for every folder, with its `id` copied exactly.

- `lineIds`: every line the folder's material serves, most central first. A folder of a project, paper, product, client or channel goes to the line that holds it. A folder can serve several lines (a product whose research also feeds a paper; a writing folder used for both work and content).
- **Mixed folders** (下载, 桌面, Documents): list a line only when a clear group of its files is there (several reports of one client, a run of video drafts), not for one stray file. A folder of everything with no such group gets `[]`.
- `lineIds` is empty when nothing given ties the folder to any line (personal paperwork, trip photos, an unrelated archive). Never guess a line to avoid an empty answer: a wrong line hands unrelated files to that line's tasks.

| Folder | `lineIds` | `why` |
|---|---|---|
| 「Acme 提案」: `需求访谈纪要.docx`, `报价v3.pdf`, `交付计划.md` | the line holding the Acme project | 「文件名多为 Acme 项目的提案与交付材料」 |
| 「Downloads」: 12 papers on one topic, 6 video drafts, receipts | the research line, then the content line | 「含成组的论文与视频草稿」 |
| 「旅行照片」 | [] | 「为个人照片，与各主线无关」 |

- `why`: one short clause naming what decided it, or for an empty answer, what was missing.
- Never invent a line id; never merge or split folders.

### Screening a picked folder (`crossline.folder-screen.v1`)

The person picked a folder in the browser to hand over; the hosted app cannot browse their disk, so it screens first and uploads only what you keep. Code has already left out credentials, private papers (IDs, tax, bank, visas, contracts), hidden and dependency folders and kinds the app cannot read; you see what is left.

Accept `{version: "crossline.folder-screen.v1", folder, limit, lines, files}`: `folder` (its name), `limit` (most files to keep), `lines` (`{label, description}`: the person's 主线, possibly empty) and `files` (`{index, path, size, modifiedAt}`, most recently changed first).

Return raw JSON only: `{keep: [index, …], why}`, most useful first, at most `limit`.

- Keep what tells who the person is and what they are working on: their own writing, plans, notes, drafts, CVs, proposals, reports, schedules, exported conversations with AI assistants; material clearly tied to one of their lines.
- Leave out what says little about them: installers' readmes, licence texts, auto-generated logs and exports of tools, templates never filled in, many near-identical copies (keep the newest-looking one), bulk downloads of other people's documents with no sign the person worked on them.
- When more qualify than `limit`, prefer recent files and the person's own documents over downloaded ones.
- `why`: one short clause on what was kept and what was left out.

### Filing files under projects (`crossline.file-projects.v1`)

Files whose own name or opening did not name exactly one known project written out. Code files a file by itself only when its name or the opening of its text contains one project's name or id; everything looser is yours: a code written another way, an abbreviation, a file that names a project and a part of it, a file of the project that never names it. A file you file lends its dates and its text to that project's tasks; a file you leave unfiled is asked about on 待确认 if dates were read from it.

Accept `{version: "crossline.file-projects.v1", projects, files}`: `projects` (`{id, name, lineId, summary}`) and `files` (`{id, name, opening}`: the file name and its first few hundred characters).

Return raw JSON only: `{files: [{id, projectId, why}]}`, one entry per file, `id` copied exactly.

- `projectId`: the one project the file plainly belongs to, by what its own words say. When it names a project and a part of that project (a course and its final project, a product and one launch), the general file — a syllabus, a schedule, an overview — belongs to the whole, the part's own brief to the part.
- `projectId: ""` when the file ties to none, or to several equally (notes comparing two courses, a weekly plan across projects). Never guess to avoid an empty answer: a wrong project hands that project's tasks dates and material that are not theirs.
- `why`: one short clause naming what in the file decided it.

| File | `projectId` | `why` |
|---|---|---|
| 「RBT610-Fall2026-Syllabus.pdf」 against 「RBT 610 Robot Perception」 and 「RBT 610 期末项目」 | the course | 「课程大纲属于课程本身」 |
| 「Q3 pitch v2.pptx」, opening 「Acme seed round」 | Acme | 「开头写明 Acme 融资」 |
| 「weekly plan.md」 naming three projects | "" | 「同时涉及三个项目」 |

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`why` in Simplified Chinese, concise, objective third person; file names and codes quoted verbatim.

## `mode: "time"` — Untimed screen work

Say which of the person's open Crossline tasks (and step) each stretch of untimed screen work was for, from its app and window titles, or none.

The person forgot to start the timer. Crossline drafted these stretches from the screen record (app and window titles only, nothing else captured) and could not tell from the person's rules or their calendar blocks whose time they were. Your answer is a proposal shown on the evening wrap-up as 「这些时间在做什么？」: the person confirms it, picks another task, or says it was not work. Only a confirmed stretch becomes measured time. A wrong task costs the person a correction; a stretch left unattributed costs them one pick from a list.

Accept `{version: "crossline.time-attribution.v1", tasks, stretches}`:

- `tasks`: the person's open tasks: `id`, `title`, `line` (the 主线 it belongs to) and `steps` (`id`, `title`, `kind`: the step type, such as 撰写, 阅读, 测试验证) still to do.
- `stretches`: `id`, `when` (local day and time), `minutes`, `app` (the program most of it was in), `category` (编程, 科研工具, 写作, 阅读 …) and `titles` (window titles, most time first).

Return raw JSON only: `{items: [{id, workOrderId, stepId, why}]}`, one item for every stretch, its `id` copied exactly.

### Deciding

- **A task**: `workOrderId` is the task the titles plainly name or belong to: a course code, a paper's or project's name, a file name that matches a task's title, a repository that is the task's. `stepId` is the step whose kind fits the work (a writing app → a 撰写 or 修订 step; a simulator → a 测试验证 step), or "" when no one step clearly fits.
- **None**: `workOrderId: ""`, `stepId: ""` when the titles name nothing in the tasks, name several tasks equally, or are generic (「新建标签页」「Untitled」「Downloads」). Never pick a task because it is the only one on a line or because the category matches; a title has to tie it.
- `why`: one short clause quoting what in the titles decided it, or what is missing.
- Never invent an id; only ids from `tasks` and their `steps`.

| Stretch | Answer | `why` |
|---|---|---|
| 40 min in WINWORD, titles 「ECE555_HW3.docx」, task 「完成 ECE 555 作业 3」 | that task, its 撰写 step if one is open | 「标题中的 ECE555_HW3 对应作业 3」 |
| 25 min in Code, titles 「crossline – timer.ts」, no task names crossline | "" | 「标题只有仓库名，任务中无对应项」 |
| 30 min in chrome, titles 「Overleaf – NeurIPS draft」, tasks 「NeurIPS 论文初稿」 and 「ICML 审稿」 | the NeurIPS task | 「Overleaf 项目名为 NeurIPS draft」 |

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. Quotes from the titles stay verbatim; ids stay exactly as given.

`why` in Simplified Chinese, concise, objective third person.
