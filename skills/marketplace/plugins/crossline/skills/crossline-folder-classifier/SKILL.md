---
name: crossline-folder-classifier
description: Decide which of the person's Crossline lines each folder they authorized serves — one, several or none — from the folder's name, its file names and the openings of a few files; and screen a folder the person picked for upload, keeping the files worth reading by name, format, size and date.
---

# Crossline Folder Classifier

Two jobs on the person's folders, told apart by `version`.

## Filing folders under lines (`crossline.folder-lines.v1`)

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

## Screening a picked folder (`crossline.folder-screen.v1`)

The person picked a folder in the browser to hand over; the hosted app cannot browse their disk, so it screens first and uploads only what you keep. Code has already left out credentials, private papers (IDs, tax, bank, visas, contracts), hidden and dependency folders and kinds the app cannot read; you see what is left.

Accept `{version: "crossline.folder-screen.v1", folder, limit, lines, files}`: `folder` (its name), `limit` (most files to keep), `lines` (`{label, description}`: the person's 主线, possibly empty) and `files` (`{index, path, size, modifiedAt}`, most recently changed first).

Return raw JSON only: `{keep: [index, …], why}`, most useful first, at most `limit`.

- Keep what tells who the person is and what they are working on: their own writing, plans, notes, drafts, CVs, proposals, reports, schedules, exported conversations with AI assistants; material clearly tied to one of their lines.
- Leave out what says little about them: installers' readmes, licence texts, auto-generated logs and exports of tools, templates never filled in, many near-identical copies (keep the newest-looking one), bulk downloads of other people's documents with no sign the person worked on them.
- When more qualify than `limit`, prefer recent files and the person's own documents over downloaded ones.
- `why`: one short clause on what was kept and what was left out.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`why` in Simplified Chinese, concise, objective third person; file names and codes quoted verbatim.
