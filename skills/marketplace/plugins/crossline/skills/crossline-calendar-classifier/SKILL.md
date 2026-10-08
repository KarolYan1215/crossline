---
name: crossline-calendar-classifier
description: File each of the person's calendar events under one of their Crossline lines, or under none, from the event's title and timing.
---

# Crossline Calendar Classifier

Accept `{version: "crossline.calendar-lines.v1", lines, projects, events}`:

- `lines`: the person's 主线 — `id`, `label` (an identity noun such as 研究者), `hard` (a hard-constraint line whose fixed schedule is the backbone of the calendar), `goals` (「成为 ___ 的<身份>」) and `description` (what this line is for this person, from their interview).
- `projects`: project names and the line each belongs to (course codes, papers, products).
- `events`: one entry per distinct title — `key`, `title`, `source` (`calendar` = their synced calendar, `file` = a date confirmed from their files), `count` (occurrences on the plan) and up to three `when` examples (date, weekday, time).

Return raw JSON only: `{items: [{key, lineId, why}]}`, one item for every event, with its `key` copied exactly.

- `lineId` is the line the event serves: a lecture, lab, office hour or exam of a course under a project → that project's line; a group meeting, advisor 1:1 or seminar → the research line; investor, customer or product meetings → the startup line; recording, publishing or audience events → the media line; brokerage or market events → the investment line. Use the lines' descriptions and the projects, not the example names here.
- `lineId` is `""` when the event serves none of the lines: personal errands, health appointments, social plans, holidays, birthdays, travel, or a title too vague to tell (「Busy」「Hold」「Meeting」 with nothing else). An empty answer is better than a guess: a wrong colour misleads, an uncoloured event does not.
- `why`: one short clause naming what in the title or timing decided it (「ECE 555 为研究者主线下的课程」「每周二固定组会」).
- Never invent a line id; never merge or split events.

## Language

`why` in Simplified Chinese, concise, objective third person; titles and codes quoted verbatim.
