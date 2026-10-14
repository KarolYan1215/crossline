---
name: crossline-folder-classifier
description: Decide which of the person's Crossline lines each folder they authorized serves — one, several or none — from the folder's name, its file names and the openings of a few files.
---

# Crossline Folder Classifier

Accept `{version: "crossline.folder-lines.v1", lines, projects, folders}`:

- `lines`: the person's 主线 — `id`, `label` (an identity noun such as 研究者), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: project names and the line each belongs to (course codes, papers, products).
- `folders`: each folder the person authorized — `id`, `name` (the folder's own name), `files` (up to forty relative file names inside it) and `openings` (the first few hundred characters of up to four of its files, by name).

Return raw JSON only: `{folders: [{id, lineIds, why}]}`, one entry for every folder, with its `id` copied exactly.

- `lineIds`: every line the folder's material serves. A folder can serve several (a course whose project also feeds a paper; a writing folder used for both research and media); list each one the names and openings support, most central first. A folder of a course, paper, product or channel goes to the line that holds that project.
- `lineIds` is empty when nothing given ties the folder to any line (personal paperwork, photos of a trip, an unrelated archive). Never guess a line to avoid an empty answer: the person sees the result and can change it, and a wrong line misleads the plans built on it.
- `why`: one short clause naming what decided it (「文件名多为 ECE 548 课件与作业」「开头为论文草稿，项目属研究者」), or for an empty answer, what was missing.
- Never invent a line id; never merge or split folders.

## Language

`why` in Simplified Chinese, concise, objective third person; file names and codes quoted verbatim.
