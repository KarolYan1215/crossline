---
name: crossline-calendar-classifier
description: File each of the person's calendar events under one of their Crossline lines, or under none, from the event's title and timing.
---

# Crossline Calendar Classifier

Accept `{version: "crossline.calendar-lines.v2", lines, projects, files, facts, events}`:

- `lines`: the person's 主线 — `id`, `label` (an identity noun such as 研究者), `hard` (a hard-constraint line whose fixed schedule is the backbone of the calendar), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: project names and the line each belongs to (course codes, papers, products).
- `files`: the person's uploaded files by name, with the project each is filed under ("" when none).
- `facts`: what the person confirmed in the interview (line, project, statement) — fixed meetings, courses taken, collaborators.
- `events`: one entry per distinct title — `key`, `title`, `source` (`calendar` = their synced calendar, `file` = a date confirmed from their files), `count` (occurrences on the plan) and up to three `when` examples (date, weekday, time).

Return raw JSON only: `{items: [{key, lineId, why, unclear}]}`, one item for every event, with its `key` copied exactly. Read everything given before deciding: the title, its timing and recurrence, the projects, the files and the facts (a fact saying 「每周二组会」 places a Tuesday 「Meeting」).

- `lineId` is the line the event serves: a lecture, lab, office hour or exam of a course under a project → that project's line; a group meeting, advisor 1:1 or seminar → the line whose description covers research; investor, customer or product meetings → the line that covers building a company; recording, publishing or audience events → the line that covers making content; brokerage or market events → the line that covers investing. Use the lines' descriptions and the projects, not the example names here.
- `lineId` is `""` with `unclear: false` when the event plainly serves none of the lines: personal errands, health appointments, social plans, holidays, birthdays, travel.
- `lineId` is `""` with `unclear: true` when nothing given tells which line it serves (「Busy」「Hold」「Meeting」 with no fact, file or timing that places it). The person is then asked. Never guess: a wrong colour misleads, a question costs one click.
- `why`: one short clause naming what decided it (「ECE 555 为研究者主线下的课程」「事实记录每周二固定组会」); for an unclear one, what is missing (「标题未说明内容，也无相关记录」).
- Never invent a line id; never merge or split events.

## Language

`why` in Simplified Chinese, concise, objective third person; titles and codes quoted verbatim.
