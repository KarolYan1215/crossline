---
name: crossline-calendar-classifier
description: File each of the person's calendar events under one of their Crossline lines, or under none, from the event's title and timing.
---

# Crossline Calendar Classifier

The answer colours the person's day, week and month views: an event filed under a line takes that line's colour, one filed under none stays grey, and one marked unclear is asked about on 待确认 (the person's answer is final and never refiled). A wrong colour misleads every view of the week; a question costs one click.

Accept `{version: "crossline.calendar-lines.v2", lines, projects, files, facts, events}`:

- `lines`: the person's 主线: `id`, `label` (an identity noun such as 研究者), `hard` (a line whose fixed schedule, such as classes, is the backbone of the week), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: `{name, lineId}`: course codes, papers, products, channels, and the line each belongs to.
- `files`: the person's uploaded files by `name`, with the `project` each is filed under ("" when none).
- `facts`: what the person confirmed (`lineId`, `project`, `statement`): fixed meetings, courses taken, collaborators.
- `events`: one entry per distinct title: `key`, `title`, `source` (`calendar` = their synced calendar, `file` = a date confirmed from their files), `count` (occurrences on the plan) and up to three `when` examples (date, weekday, time).

Return raw JSON only: `{items: [{key, lineId, why, unclear}]}`, one item for every event, with its `key` copied exactly. Read everything before deciding: the title, its timing and recurrence, the projects, the files and the facts (a fact saying 「每周二组会」 places a Tuesday 「Meeting」; a weekly slot matching a hard line's class times belongs to that line).

## Deciding

- **A line**: `lineId` is the line the event serves, `unclear: false`. A course's lecture, lab, office hour or exam → the line holding that course's project; a group meeting, advisor 1:1 or seminar → the line whose description covers research; investor, customer or product meetings → the line that covers building a company; recording, publishing or audience events → the line that covers making content; market events → the line that covers investing. Go by the lines' descriptions and projects, not by these example kinds. An event that touches two lines goes to the one its title or project names.
- **None**: `lineId: ""`, `unclear: false`, when the event plainly serves none of the lines: personal errands, health appointments, social plans, holidays, birthdays, travel.
- **Unclear**: `lineId: ""`, `unclear: true`, when nothing given tells which line it serves (「Busy」「Hold」「Meeting」 with no fact, file or timing that places it). Never guess a line to avoid asking. `unclear` is true only with an empty `lineId`.

| Event | Answer | `why` |
|---|---|---|
| 「ECE 555 Lecture」, Tue/Thu 09:30, project ECE 555 on the 研究者 line | that line's id | 「ECE 555 为研究者主线下的课程」 |
| 「Meeting」 every Tuesday 14:00, fact 「每周二下午固定组会」 on the 研究者 line | that line's id | 「事实记录每周二固定组会」 |
| 「Dentist」 | "" | 「个人就医，不属于任何主线」 |
| 「Hold」 once, no fact or file mentions it | "", unclear | 「标题未说明内容，也无相关记录」 |

- `why`: one short clause naming what decided it, or for an unclear one, what is missing.
- Never invent a line id; never merge or split events.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`why` in Simplified Chinese, concise, objective third person; titles and codes quoted verbatim.
