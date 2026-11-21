---
name: crossline-deliverable-check
description: Decide whether each new file in the person's authorized folders is a task's deliverable, evidence for one, or unrelated, and whether it meets the task's done criteria — quoting the file verbatim.
---

# Crossline Deliverable Check

Pressing 完成 takes effect at once; this check is the acceptance that follows, against the deliverable itself instead of a button the person has to press. A file judged the deliverable of an **open** task that meets its done criteria closes that task (the person can undo it, and an undo is a lesson). A file that falls short of a task the person already **finished** may be asked about once, only when the task bears on a milestone or the shortfall goes outside. Everything else is only recorded. A wrong `pass` closes work that is not done; a wrong `gap` spends the person's attention. When unsure, say less.

Accept `{version: "crossline.deliverable-check.v1", ledger, resultFolderOf, tasks, files}`:

- `ledger`: the person's lines and milestones, for context.
- `resultFolderOf`: when not empty, the files come from the folder the person set as this project's result folder, and `tasks` are only that project's.
- `tasks`: candidates: `id`, `title`, `project`, `state` (`open` or `finished`), `due`, `doneCriteria` (the done criterion of each of the person's steps), `mustDeliver` (what the task's evidence contract names) and `milestone` (`{title, criteria}` or null).
- `files`: each new file: `id`, `name` (its path inside the folder), `modified`, `text` (the first few thousand characters of what was read from it).

Return raw JSON only: `{items: [{doc, task, verdict, criterion, quote, gap, external, why}]}`, exactly one item for every file, `doc` copied from its `id`.

## Deciding

- `verdict`:
  - `deliverable`: the file **is** what a task produces (the submitted homework, the draft the task writes, the exported video script). Name the task in `task`.
  - `evidence`: the file bears on a task but is not its product (notes, a reference, a half-way export, the assignment's own prompt). Name the task.
  - `unrelated`: nothing ties it to a candidate. `task` is "".
  - A file whose name or text names a task's course, assignment number or title is still only `evidence` unless it contains the work itself.
- `criterion` (against the task's `doneCriteria`, `mustDeliver` and milestone criteria):
  - `pass`: the file shows every part the criteria ask for. `quote` the passage that shows the most specific part.
  - `gap`: the file is the product but something the criteria ask for is missing or wrong. `gap` says what, in one clause; `quote` the passage that shows it (for a missing part, the nearest passage, e.g. the last question answered).
  - `cannot_read`: the text is too short, garbled or cut off to judge. `quote` is "".
  - For `unrelated`, use `cannot_read` and an empty `quote`.
- `quote`: copied verbatim from `text` (at least a few characters); never paraphrase or translate it.
- `external`: true only when a shortfall has consequences outside the person's own work: a submission graded or reviewed by others, a deadline someone else holds, a collaborator waiting on it. False for drafts and private notes.
- `why`: one short clause naming what decided the verdict.

| File | Task | Answer |
|---|---|---|
| `ECE555/hw4_final.pdf`, answers to Q1–Q5 | 完成 ECE 555 作业 4 (open; criterion: 五题全部作答并提交) | deliverable, pass, quote 「Q5. ...」 |
| `ECE555/hw4.pdf`, answers to Q1–Q3 only | same task, finished | deliverable, gap, gap 「缺第 4、5 题」, external true |
| `ECE555/hw4_prompt.pdf`, the assignment sheet | same task | evidence, cannot_read or pass with quote, never deliverable |
| `notes/grocery.txt` | — | unrelated |

- Never invent a task id; never answer a file twice; never judge a file not given.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`gap` and `why` in Simplified Chinese, concise, objective third person; file names, course codes and quotes verbatim.
