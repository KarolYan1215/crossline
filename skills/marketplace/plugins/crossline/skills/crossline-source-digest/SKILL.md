---
name: crossline-source-digest
description: Decide whether pairs of the person's files that look alike are versions of one document, pick the latest from modification times and the versions' own signals, and write what the interview reads in place of the older one — a summary and what the latest changed.
---

# Crossline Source Digest

The person's files often hold several versions of one document: 「简历.pdf」 and 「简历-2026终稿.pdf」, a proposal before and after review, a syllabus from two terms. Reading every version in full wastes the interview's reading budget and invites quoting an outdated plan. Code has already circled pairs whose texts are close; you decide what they are. When you confirm a pair, the latest version is read in full, the older file is kept as it is, and the interview reads your summary and differences in its place — it can still open the original when it needs a verbatim check.

Accept `{version: "crossline.source-versions.v1", pairs}`. Each pair is `{a, b}`, each a file: `id`, `fileName`, `uploadedAt` (when it reached Crossline), `modifiedAt` (when the person's computer last changed it, when known), `characters` (its whole length), `opening` (its first few thousand characters) and `ending` (its last part, when it is longer).

Return raw JSON only: `{pairs: [{a, b, sameDocument, latestId, olderSummary, differences, why}]}`, one entry for every pair asked, with `a` and `b` copied exactly.

## Deciding

- `sameDocument`: true only when both are one document at two points in its life — the same résumé, plan, paper, proposal, syllabus or notes, revised. Two different documents that share a template, a boilerplate header or a course's standard text are not one document (two homework sets of one course; two cover letters to different employers; two weekly reports). When unsure, false: a false merge hides a real file from the interview.
- `latestId` (when `sameDocument`): the id of the newer version. Weigh, in this order: dates written in the text (「2026 年 3 月修订」, a dated header, the newest event mentioned); version signals in the name or text (v2 > v1, 终稿/final > 初稿/draft, 修订版/revised, a later term or year); `modifiedAt`; and only last `uploadedAt`. Content that extends the other (a section added, a result filled in, a reviewer's comment addressed) marks the newer one. A copy named 「(1)」 or 「副本」 says nothing about age.
- `olderSummary` (when `sameDocument`): two to four sentences on what the older version is and what it says, so the interview knows what was there without reading it.
- `differences` (when `sameDocument`): what the latest changed relative to the older one — added, removed or changed parts, with dates and numbers verbatim where they changed (「截止日从 3 月 1 日改为 3 月 15 日」). Say plainly when the change is only formatting.
- When `sameDocument` is false: `latestId`, `olderSummary` and `differences` are empty strings.
- `why`: one short clause naming what decided it.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. Quotes from a file stay verbatim in their own language; ids stay exactly as given.

Write `olderSummary`, `differences` and `why` concisely, in objective third person, with file names quoted verbatim.
