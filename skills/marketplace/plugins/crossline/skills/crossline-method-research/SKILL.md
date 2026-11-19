---
name: crossline-method-research
description: After the interview, put together how this person works in their own words, then research the current best way to do each kind of work their lines hold — AI tools included — checking their own files first and the web second, so every later plan follows their habits and the best known practice.
---

# Crossline Method Research

The interview has ended. You do two things once, and every later task plan (analysis, backplanner, step planner, milestone architect) is given both:

1. **The person's habits** — how they actually work, in their own words.
2. **How the work is best done now** — for each kind of work their lines hold, the current, evidence-backed way to do it, including the AI tools that help, fitted to those habits.

Input is `crossline.method-research.v1`:

- `facts`: the person's confirmed facts, each `{id, slot, value}` — their interview answers, the 做事方法 slots (`method_exam_prep`, `method_learning`, `method_writing`), energy and schedule, constraints.
- `lines`: each line `{id, label, goal, milestones, tasks}` — what they are working toward and the kinds of work on their board now.
- `aiTools`: the AI tools the person already uses or has said they can use.
- `today`, `locale`.

Return raw JSON only: `{habits, methods, sources}`.

## 1. Habits — only the person's words

Read `facts` and write up to ten habits: when and how they like to work, how they prepare, learn, write, decide, what keeps them going or stops them. Each `text` is one short sentence in the person's language, saying what they said (「考前先把讲义过一遍再做往年卷」「写东西先列提纲」「晚上 9 点后效率最高」), and `factIds` names the facts it rests on. Never add a habit nobody said, never generalise from who they are (a student is not assumed to 订正, 背诵 or 打卡), never infer a habit from a goal. An assumption (「假设：…」) is not a habit. Few facts → few habits; none is a valid answer.

## 2. Methods — local first, then the web

Group the work in `lines` into its recurring kinds (one exam's preparation, writing a paper section, shipping a product feature, making a short video, researching a stock …), at most eight, the ones that recur or matter most first. For each kind:

1. **Look in the person's own files first** with `search_my_files` / `read_my_file_passage` (or whichever lookup this run has): a syllabus, a rubric, an advisor's guidance, the team's process. What the person's own material says about how the work is done outranks anything general; cite it as a local source (`local: true`, `url` = the passage id `c123`).
2. **Then search the web**, only for what their files do not cover: the current best-supported way to do this kind of work and the AI tools that do part of it well today (named products and what they do in this work, e.g. 「NotebookLM：把讲义生成问答自测」). Prefer research syntheses, university teaching and learning centres, the field's own practitioners and official tool documentation; open each page you cite. A query carries only the topic, never the person's name or private details.
3. **Fit it to the habits.** `approach` (at most 320 characters) says how to do this kind of work well, concretely enough for a planner to turn into steps. `fitsHabit` says how it bends to this person's habits (「保留先读讲义的习惯，之后改为计时做题」); where it conflicts with a habit, the habit wins and `fitsHabit` says what is kept. Empty when no habit applies.
4. `aiTools`: up to three tools with what each does in this work (`use`), only where it saves real effort or improves the result; none is fine.
5. `lineId`: the line this kind belongs to, `""` when it spans lines. `sourceIds`: one to three sources it rests on.

A method never prescribes a form the person's habits do not hold and that the work does not need from first principles: no 订正, 错题本, 背诵, 默写, 打卡 or 刷题 unless a fact says this person does it. Code removes such forms anyway.

## 3. Sources

`sources`: up to twelve, each `{id: "s1"…, url, title, local}`. A web page has its `https` URL and real title and was opened; a file passage has `local: true` and its passage id. Never cite what you did not read; never invent a figure, a study or a tool feature. The worker opens every web page and drops any that does not open or whose title does not match, with every method that rested only on it.
