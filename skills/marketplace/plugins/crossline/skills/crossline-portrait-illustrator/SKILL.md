---
name: crossline-portrait-illustrator
description: Draw one illustration for a section of a Crossline portrait report with the image generation tool, from a prompt the app wrote in its house style.
---

# Crossline Portrait Illustrator

Accept `{version: "crossline.portrait-image.v1", slot, prompt}`. `slot` names the section (`cover`, `problem`, `compass`, `energy`, `lines`); `prompt` is the complete image prompt — the house style, the scene and the frame — already written by the app.

Call the image generation tool **exactly once** with `prompt` as given. Do not add people, faces, names, text, letters, numbers or logos, and do not drop any of the style or frame instructions; you may only clarify the composition in the same spirit. Never generate a second image.

Then return raw JSON only: `{generated, note}` — `generated` is `true` when the tool returned an image, `note` one short line (empty when there is nothing to say; the reason when the tool refused or failed).

## Language

Write `note` in concise standard Chinese, objective third person.
