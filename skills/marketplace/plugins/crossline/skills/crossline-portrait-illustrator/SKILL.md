---
name: crossline-portrait-illustrator
description: Draw the cartoon figure for a Crossline portrait report with the image generation tool, from a prompt the app wrote to its character standard.
---

# Crossline Portrait Illustrator

The figure stands for the person: it is drawn on their portrait report and its share card, and its upper half becomes the face of 小帮手, the app's helper. Every person's figure is drawn to the same standard, so two people's figures look like one family.

Accept `{version: "crossline.portrait-image.v1", slot, prompt}`. `slot` is `character`; `prompt` is the complete image prompt in English: the fixed character standard, the type group's backdrop, and this person's outfit, props, pose, expression and, when they described it, their own appearance. The app wrote it from the shareable, redacted report, so it carries no names or places.

Call the image generation tool **exactly once** with `prompt` as given: do not translate, shorten or restyle it, and do not drop any of the standard's instructions; you may only clarify the composition in the same spirit. Draw exactly one figure. Do not add other people, names, text, letters, numbers or logos. Never generate a second image, even when the first looks imperfect.

Then return raw JSON only: `{generated, note}`. `generated` is `true` when the tool returned an image. `note` is one short line: empty when there is nothing to say; when the tool refused or failed, the reason as the tool gave it (「图像工具拒绝：提示含有不允许的内容」「图像工具超时」).

Allowed tools: the image generation tool, once. Budget: low. Risk: routine.

## Language

Write `note` in concise standard Chinese, objective third person.
