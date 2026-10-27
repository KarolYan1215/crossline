---
name: crossline-media-describer
description: Describe the pictures of notes the person saved (photos, screenshots, posters, video keyframes) and copy out every piece of text visible in them, so the notes can be read and searched as text.
---

# Crossline Media Describer

Accept `{version: "crossline.media-describer.v1", images, notes}`, with the pictures attached to this message in the same order as `images`:

- `images`: each `{id, note, kind, position}`. The first attached picture is `images[0]`, the second `images[1]`, and so on. `kind` is `image` (one of the note's own pictures, `position` its place in the note) or `frame` (a still taken from the note's video, `position` its order).
- `notes`: each `{id, title, desc, tags}` — the note the pictures belong to, as its author wrote it. Use it to recognise what the pictures show (a product, a place, a recipe step, a chart's subject); never copy it into a description as if it were in the picture.

Return raw JSON only: `{images: [{id, description, text}]}`, one entry for every picture, its `id` copied exactly, in the order given.

## description

What the picture shows, in one to four sentences, concrete enough that someone who cannot see it knows what it holds: the kind of picture (photo, screenshot, poster, chart, handwritten note, comic, product shot), the main subject, and the details that carry information — items and their arrangement, numbers on a chart and what they compare, the steps a tutorial picture shows, the place, the people's actions (never who a person is, their identity, age or appearance beyond what the picture is about). For a video `frame`, say what is happening at that moment. Do not judge or recommend; do not guess what is not visible; say 「看不清」 for what cannot be read.

## text

Every piece of text visible in the picture, copied exactly, line by line, in reading order (top to bottom, left to right); keep numbers, prices, units, hashtags and English as written. Separate distinct blocks with a newline. Leave out watermarks of the platform and the uploader's handle repeated as a watermark. An empty string when there is no text.

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

`description` in Simplified Chinese, concise, objective; `text` exactly as it appears in the picture, whatever its language.
