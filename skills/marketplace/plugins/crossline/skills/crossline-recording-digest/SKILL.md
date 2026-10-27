---
name: crossline-recording-digest
description: Read transcripts of the person's own phone recordings, decide which are worth keeping, and for those write a summary and pull out the person's commitments, facts about them and their work, and the days named — every item quoting the transcript.
---

# Crossline Recording Digest

Accept `{version: "crossline.recording-digest.v1", today, timeZone, lines, projects, facts, recordings}`:

- `lines`: the person's 主线 — `id`, `label` (an identity noun such as 研究者), `description`.
- `projects`: `id`, `name` and the line each belongs to (course codes, papers, products).
- `facts`: what is already known about the person (line, project, statement), so you neither repeat it nor contradict it without cause.
- `recordings`: each `{id, fileName, startedAt, minutes, text}`. `text` is a machine transcript of a phone that recorded the person's day: one line per stretch of speech, prefixed with its time in the recording (`[00:20]`). The recogniser makes mistakes (homophones, wrong names). A long text may be cut in the middle (`[……中间省略……]`).
  - **Speakers.** A transcript made on the server usually names a speaker per line: `[00:20] 说话人 1：…`. The numbers only tell voices apart within this recording; a television or video playing is a speaker too. When the person turned on voice recognition, their own lines read `[00:20] 本人：…` — then a line marked 本人 is the person and any other speaker is not, so a commitment is `by: "person"` only when its quote is in a 本人 line (the app checks this and overrides you). Without any 本人 line, judge who speaks from the words as below. An older or local transcript has no speaker labels at all.

Return raw JSON only: `{recordings: [{id, kind, title, summary, lineIds, projectId, commitments, facts, dates}]}`, one entry for every recording, its `id` copied exactly.

## Deciding what it is

`kind` is one of:

- `meeting` (several people working something out), `lecture` (a class, talk or seminar), `call` (a phone or video call), `conversation` (a substantive talk between a few people: advice, planning, a decision), `self_note` (the person speaking their own thoughts, plans or a to-do list);
- `small_talk` (chat with no decision, plan or information worth keeping), `media` (a video, show, podcast or music playing — scripted speech, ads, subtitles' stock phrases such as 「谢谢观看」「请不吝点赞订阅」), `noise` (fragments, unintelligible or empty).

Only the first five are kept. For `small_talk`, `media` and `noise` return an empty `summary`, `commitments`, `facts` and `dates`, and a `title` saying what it was (「午饭闲聊」「视频播放声」). When unsure between keeping and not, keep it as `conversation` and say so in the summary.

## For a kept recording

- `title`: ≤20 characters naming the occasion and its subject (「ECE 548 第 7 讲：随机过程」「与导师讨论开题」).
- `summary`: what was discussed and decided, in the order it happened, ≤400 characters — enough that someone planning the person's week knows what came out of it. For a lecture: topics covered and anything announced (homework, exam, deadlines). Name people as the transcript names them; never invent names. When lines carry speaker labels, say who held which view by those labels (「说话人 2 主张…」), or by a name the conversation itself gives that speaker.
- `lineIds`: the lines the content serves (from `lines`, most central first); empty when none fits. `projectId`: one id from `projects` when the content plainly belongs to it (a course code said aloud, the paper's topic), else `""`.
- `commitments`: things someone said would be done. `text` is a short task phrased as an action (「把实验数据发给王老师」); `by` is `person` only when the words make clear the speaker is the person themselves committing (「我来写」「我明天发你」 in a self_note, or in a conversation where the context shows who is speaking), `other` when someone else commits to the person (「我下周把数据给你」 said to them), `unclear` otherwise — including anything that could be from a video or someone else's conversation. `who` is the other party as the transcript names them (「王老师」「小李」) for `other`, else `""`; never a guessed name. `due` is `YYYY-MM-DD` when a day is named (resolve 「明天」「下周三」 from `startedAt` and `today`), else `""`. At most the five most important; ignore trivia (「我去倒杯水」). What `other` commits to the person becomes a 「在等」 item asked about on its day, so keep only promises of something the person actually needs.
- `facts`: lasting information about the person or their work that a planner would want and `facts` does not already hold — a deadline, a requirement, a collaborator's role, a preference the person states about how they work. `identityId` is `person` or a line id; `projectId` a project id or `""`; `slot` a short snake_case key (`advisor_expectation`, `exam_format`, `deadline_paper_draft`); `value` one sentence. Do not record what was said by a video, small talk, or one-off moods.
- `dates`: days named for something to happen (an exam, a meeting, a submission) — `title` naming the course or project (「ECE 555 期中考试」), `date` `YYYY-MM-DD`, `time` `HH:MM` or `""`. One with a time is offered to the person as a calendar event they decide on; give `time` only when the transcript states it.

Every commitment, fact and date carries `quote`: a span copied verbatim from that recording's `text` (without the `[00:20]` prefix) that says it. Never paraphrase a quote; an item whose quote is not in the text is discarded. Never invent a date, number or name the text does not contain; when the recogniser garbled a word, quote it as it is and write the likely meaning in `text`/`value`.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`title`, `summary`, `text`, `value` in Simplified Chinese, concise, objective third person (「本人」 for the person); course codes, names and quotes as they appear.
