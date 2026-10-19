---
name: crossline-folder-classifier
description: Decide which of the person's Crossline lines each folder they authorized serves — one, several or none — from the folder's name, its file names and the openings of a few files.
---

# Crossline Folder Classifier

The answer decides whose material a folder is: when a task has few files of its own, its step plan is given the files of the folders filed under the task's line, so a folder filed under the 研究者 line lends its lecture notes to that line's tasks. The person sees the result on the folder's card and can change it; their choice is never replaced.

Accept `{version: "crossline.folder-lines.v1", lines, projects, folders}`:

- `lines`: the person's 主线: `id`, `label` (an identity noun such as 研究者), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: `{name, lineId}`: course codes, papers, products, channels, and the line each belongs to.
- `folders`: each folder the person authorized: `id`, `name` (the folder's own name), `files` (up to forty relative file names inside it) and `openings` (`{name, text}`: the first few hundred characters of up to four of its files).

Return raw JSON only: `{folders: [{id, lineIds, why}]}`, one entry for every folder, with its `id` copied exactly.

## Deciding

- `lineIds`: every line the folder's material serves, most central first. A folder of a course, paper, product or channel goes to the line that holds that project. A folder can serve several lines (a course whose project also feeds a paper; a writing folder used for both research and content).
- **Mixed folders** (下载, 桌面, Documents): list a line only when a clear group of its files is there (several lecture PDFs of one course, a run of video drafts), not for one stray file. A folder of everything with no such group gets `[]`.
- `lineIds` is empty when nothing given ties the folder to any line (personal paperwork, trip photos, an unrelated archive). Never guess a line to avoid an empty answer: a wrong line hands unrelated files to that line's tasks.

| Folder | `lineIds` | `why` |
|---|---|---|
| 「ECE548」: `Lecture03.pdf`, `HW2.pdf`, `syllabus.docx` | the line holding ECE 548 | 「文件名多为 ECE 548 课件与作业」 |
| 「Downloads」: 12 ECE 555 slides, 6 video drafts, receipts | the course's line, then the content line | 「含成组的 ECE 555 课件与视频草稿」 |
| 「旅行照片」 | [] | 「为个人照片，与各主线无关」 |

- `why`: one short clause naming what decided it, or for an empty answer, what was missing.
- Never invent a line id; never merge or split folders.

## Language

`why` in Simplified Chinese, concise, objective third person; file names and codes quoted verbatim.
