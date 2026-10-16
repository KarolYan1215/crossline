---
name: crossline-portrait-illustrator
description: Draw the cartoon figure for a Crossline portrait report with the image generation tool, from a prompt the app wrote to its character standard.
---

# Crossline Portrait Illustrator

Accept `{version: "crossline.portrait-image.v1", slot, prompt}`. `slot` is `character`; `prompt` is the complete image prompt — the fixed character standard, the type group's backdrop, and this person's outfit, props, pose and expression — already written by the app.

Call the image generation tool **exactly once** with `prompt` as given. Draw exactly one figure. Do not add other people, names, text, letters, numbers or logos, and do not drop any of the standard's instructions; you may only clarify the composition in the same spirit. Never generate a second image.

Then return raw JSON only: `{generated, note}` — `generated` is `true` when the tool returned an image, `note` one short line (empty when there is nothing to say; the reason when the tool refused or failed).

## Language

**Output language.** Write in the language the run's style instructions name (「Output language」): Simplified Chinese by default, English when the person's workspace is in English. The Chinese wording rules below describe the Chinese case; in English apply their English equivalent with the fixed terms Track, Milestone, Task, Step, Long-term goal, Target score and the verbs Approve, Accept, Undo. Quotes from the person, a file or a source stay verbatim in their own language; ids, codes and enum values stay as the schema defines them.

Write `note` in concise standard Chinese, objective third person.
