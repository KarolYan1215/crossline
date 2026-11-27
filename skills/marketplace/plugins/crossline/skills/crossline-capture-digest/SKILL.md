---
name: crossline-capture-digest
description: Digesting what the person captured or handed over: phone recordings (`recording`), look-alike files and AI chat exports (`source`), and one capture's background facts (`background`). The input's `mode` says which.
---

# Crossline capture digest

Digesting what the person captured or handed over: phone recordings (`recording`), look-alike files and AI chat exports (`source`), and one capture's background facts (`background`).

Every run's input carries `mode`: `recording` (Phone recordings), `source` (Look-alike files and chat exports), `background` (Background facts). Follow only the section for that `mode`; each keeps its own input and output schema, unchanged.

## `mode: "recording"` — Phone recordings

Read transcripts of the person's own phone recordings, decide which are worth keeping, and for those write a summary and pull out the person's commitments, facts about them and their work, and the days named — every item quoting the transcript.

Accept `{version: "crossline.recording-digest.v1", today, timeZone, lines, projects, facts, recordings}`:

- `lines`: the person's 主线 — `id`, `label` (an identity noun such as 研究者), `description`.
- `projects`: `id`, `name` and the line each belongs to (course codes, papers, products).
- `facts`: what is already known about the person (line, project, statement), so you neither repeat it nor contradict it without cause.
- `recordings`: each `{id, fileName, startedAt, minutes, text}`. `text` is a machine transcript of a phone that recorded the person's day: one line per stretch of speech, prefixed with its time in the recording (`[00:20]`). The recogniser makes mistakes (homophones, wrong names). A long text may be cut in the middle (`[……中间省略……]`).
  - **Speakers.** A transcript made on the server usually names a speaker per line: `[00:20] 说话人 1：…`. The numbers only tell voices apart within this recording; a television or video playing is a speaker too. When the person turned on voice recognition, their own lines read `[00:20] 本人：…` — then a line marked 本人 is the person and any other speaker is not, so a commitment is `by: "person"` only when its quote is in a 本人 line (the app checks this and overrides you). Without any 本人 line, judge who speaks from the words as below. An older or local transcript has no speaker labels at all.

Return raw JSON only: `{recordings: [{id, kind, title, summary, lineIds, projectId, commitments, facts, dates}]}`, one entry for every recording, its `id` copied exactly.

### Deciding what it is

`kind` is one of:

- `meeting` (several people working something out), `lecture` (a class, talk or seminar), `call` (a phone or video call), `conversation` (a substantive talk between a few people: advice, planning, a decision), `self_note` (the person speaking their own thoughts, plans or a to-do list);
- `small_talk` (chat with no decision, plan or information worth keeping), `media` (a video, show, podcast or music playing — scripted speech, ads, subtitles' stock phrases such as 「谢谢观看」「请不吝点赞订阅」), `noise` (fragments, unintelligible or empty).

Only the first five are kept. For `small_talk`, `media` and `noise` return an empty `summary`, `commitments`, `facts` and `dates`, and a `title` saying what it was (「午饭闲聊」「视频播放声」). When unsure between keeping and not, keep it as `conversation` and say so in the summary.

### For a kept recording

- `title`: ≤20 characters naming the occasion and its subject (「ECE 548 第 7 讲：随机过程」「与导师讨论开题」).
- `summary`: what was discussed and decided, in the order it happened, ≤400 characters — enough that someone planning the person's week knows what came out of it. For a lecture: topics covered and anything announced (homework, exam, deadlines). Name people as the transcript names them; never invent names. When lines carry speaker labels, say who held which view by those labels (「说话人 2 主张…」), or by a name the conversation itself gives that speaker.
- `lineIds`: the lines the content serves (from `lines`, most central first); empty when none fits. `projectId`: one id from `projects` when the content plainly belongs to it (a course code said aloud, the paper's topic), else `""`.
- `commitments`: things someone said would be done. `text` is a short task phrased as an action (「把实验数据发给王老师」); `by` is `person` only when the words make clear the speaker is the person themselves committing (「我来写」「我明天发你」 in a self_note, or in a conversation where the context shows who is speaking), `other` when someone else commits to the person (「我下周把数据给你」 said to them), `unclear` otherwise — including anything that could be from a video or someone else's conversation. `who` is the other party as the transcript names them (「王老师」「小李」) for `other`, else `""`; never a guessed name. `due` is `YYYY-MM-DD` when a day is named (resolve 「明天」「下周三」 from `startedAt` and `today`), else `""`. At most the five most important; ignore trivia (「我去倒杯水」). What `other` commits to the person becomes a 「在等」 item asked about on its day, so keep only promises of something the person actually needs.
- `facts`: lasting information about the person or their work that a planner would want and `facts` does not already hold — a deadline, a requirement, a collaborator's role, a preference the person states about how they work. `identityId` is `person` or a line id; `projectId` a project id or `""`; `slot` a short snake_case key (`advisor_expectation`, `exam_format`, `deadline_paper_draft`); `value` one sentence. Do not record what was said by a video, small talk, or one-off moods.
- `dates`: days named for something to happen (an exam, a meeting, a submission) — `title` naming the course or project (「ECE 555 期中考试」), `date` `YYYY-MM-DD`, `time` `HH:MM` or `""`. One with a time is offered to the person as a calendar event they decide on; give `time` only when the transcript states it.

Every commitment, fact and date carries `quote`: a span copied verbatim from that recording's `text` (without the `[00:20]` prefix) that says it. Never paraphrase a quote; an item whose quote is not in the text is discarded. Never invent a date, number or name the text does not contain; when the recogniser garbled a word, quote it as it is and write the likely meaning in `text`/`value`.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`title`, `summary`, `text`, `value` in Simplified Chinese, concise, objective third person (「本人」 for the person); course codes, names and quotes as they appear.

## `mode: "source"` — Look-alike files and chat exports

Decide whether pairs of the person's files that look alike are versions of one document, pick the latest from modification times and the versions' own signals, and write what the interview reads in place of the older one — a summary and what the latest changed; and summarize each conversation of an AI chat export the person gave, which the interview reads in place of the export.

The person's files often hold several versions of one document: 「简历.pdf」 and 「简历-2026终稿.pdf」, a proposal before and after review, a syllabus from two terms. Reading every version in full wastes the interview's reading budget and invites quoting an outdated plan. Code has already circled pairs whose texts are close; you decide what they are. When you confirm a pair, the latest version is read in full, the older file is kept as it is, and the interview reads your summary and differences in its place — it can still open the original when it needs a verbatim check.

Accept `{version: "crossline.source-versions.v1", pairs}`. Each pair is `{a, b}`, each a file: `id`, `fileName`, `uploadedAt` (when it reached Crossline), `modifiedAt` (when the person's computer last changed it, when known), `characters` (its whole length), `opening` (its first few thousand characters) and `ending` (its last part, when it is longer).

Return raw JSON only: `{pairs: [{a, b, sameDocument, latestId, olderSummary, differences, why}]}`, one entry for every pair asked, with `a` and `b` copied exactly.

### Deciding

- `sameDocument`: true only when both are one document at two points in its life — the same résumé, plan, paper, proposal, syllabus or notes, revised. Two different documents that share a template, a boilerplate header or a course's standard text are not one document (two homework sets of one course; two cover letters to different employers; two weekly reports). When unsure, false: a false merge hides a real file from the interview.
- `latestId` (when `sameDocument`): the id of the newer version. Weigh, in this order: dates written in the text (「2026 年 3 月修订」, a dated header, the newest event mentioned); version signals in the name or text (v2 > v1, 终稿/final > 初稿/draft, 修订版/revised, a later term or year); `modifiedAt`; and only last `uploadedAt`. Content that extends the other (a section added, a result filled in, a reviewer's comment addressed) marks the newer one. A copy named 「(1)」 or 「副本」 says nothing about age.
- `olderSummary` (when `sameDocument`): two to four sentences on what the older version is and what it says, so the interview knows what was there without reading it.
- `differences` (when `sameDocument`): what the latest changed relative to the older one — added, removed or changed parts, with dates and numbers verbatim where they changed (「截止日从 3 月 1 日改为 3 月 15 日」). Say plainly when the change is only formatting.
- When `sameDocument` is false: `latestId`, `olderSummary` and `differences` are empty strings.
- `why`: one short clause naming what decided it.

### AI 对话记录 (chat exports)

A second kind of input: `{version: "crossline.chat-digest.v1", source, segments}`. The person gave an export of their conversations with an AI assistant (ChatGPT, Codex, Claude Code). Code has already kept only what the person typed — system prompts, instruction files, tool output and every assistant reply are gone — and masked keys and ID numbers. Each segment is one conversation: `id`, `heading` (its date and title) and `said` (the person's messages, `- ` per message, possibly cut).

Return raw JSON only: `{segments: [{id, summary}]}`, one entry per segment asked, `id` copied exactly.

- `summary`: two to four sentences on what the person was working on, asking or deciding in this conversation, read from their own words: the project, course, product or question named; what they wanted done or understood; any date, number, constraint, preference or plan they stated (verbatim where it matters: 「3 月 15 日前投出」). The interview reads these to know the person's work and ways of working without reading every message, so keep what says something about the person, their goals and their situation, and leave out how the assistant answered (it is not there).
- Only what the messages say: never guess what the assistant replied or how it ended. A conversation of pasted code or logs with little of the person's own words is said to be that in one sentence (「主要贴了 Python 报错日志，在调试数据清洗脚本」).
- Write it in objective third person (「本人」 in Chinese), not as advice.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. Quotes from a file stay verbatim in their own language; ids stay exactly as given.

Write `olderSummary`, `differences` and `why` concisely, in objective third person, with file names quoted verbatim.

## `mode: "background"` — Background facts

Silently compact one capture into structured background facts about the user's own identities — never a conversation, never a classification of the capture itself.

Runs silently right after the person captures something (a line typed or shared into the app). Nobody waits for it and nobody talks to it. What it keeps appears under 「相关背景」 on every later task of the same line, as the fact's `value` with its `why` beneath, so a task about the same paper or client already carries what this capture said.

Accept `{version: "crossline.background-facts.v1", identities[], existingFacts[], captureTitle, captureContext}`: the person's lines (`{id, label}`), the background facts already kept (`{identityId, key, value, updatedAt}`), and the capture's own title and context. Return `{facts[], blockers[]}`; each fact carries `identityId, key, value, why, sourceQuote`.

### What is worth keeping

Something durable that many later tasks on the same line would want to know already: the title of the paper or experiment under way, a key file or repository path, the name of a client, a collaborator or a project, a fixed term of an agreement. Never the task itself, a date that only this task needs, or a passing remark.

Most captures have nothing durable in them; an empty `facts` array is the normal, successful result. You are not deciding which line the capture belongs to (that is another step); for each fact you keep, `identityId` is the line the fact is *about*.

| Capture | Keep | Not |
|---|---|---|
| 「把 MoS₂ 忆阻器那篇的图 3 重画一下，论文暂名《Hysteresis-free MoS₂ synapses》」 | `{identityId: "research", key: "current_paper_title", value: "论文暂名《Hysteresis-free MoS₂ synapses》", why: "同一篇论文的写作和改图任务都会用到这个题目", sourceQuote: "论文暂名《Hysteresis-free MoS₂ synapses》"}` | 「重画图 3」 (the task itself) |
| 「给杭州那家咖啡连锁发报价，对接人是王经理」 | `{identityId: "startup", key: "client_contact", value: "咖啡连锁客户的对接人为王经理", why: "后续报价和回访都找同一位对接人", sourceQuote: "对接人是王经理"}` | 「发报价」 |
| 「明天交作业 2」 | nothing | the due day only matters to this task |

### Rules

- `key`: short, stable, snake_case (`current_paper_title`, `main_repo_path`, `client_contact`), reused across captures: when `existingFacts` already has the key for that line, write the same key with the new value so it overwrites instead of adding a near-duplicate. Write a fact only when it is new or changed.
- `value`: one readable line in Chinese that stands on its own under 「相关背景」; names, titles and paths stay exactly as written.
- `why`: one sentence on which later work it helps.
- `sourceQuote`: an exact substring of `captureTitle` or `captureContext`, at least four characters, never a paraphrase. A quote that is not found verbatim sends the whole answer back.
- `blockers` only for something that actually prevents processing (malformed input), never to say "nothing to extract".

Allowed tools: none. Read only the supplied context; do not read or write any file, and do not call this app's own repository. Budget: low. Risk: routine, read-only compaction with no side effects beyond the structured facts it returns.

### Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
