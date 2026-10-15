import { blockText, textToBlocks } from "./doc-blocks";
import { KIND_LABEL, materialKind } from "./kinds";

/**
 * The note beside one of the person's own files: what it is (its kind, its length, the sections it is made of) and which steps of the
 * task it serves — the steps the tutorial wrote about it, and the steps whose content units were read out of it. Pure.
 */
export type FileDigest = {
  kindLabel: string; characters: number; sections: string[];
  steps: Array<{ stepId?: string; title: string; notes: string[] }>;
};

const squash = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

export function fileDigest(input: {
  fileName: string; extractedText: string;
  /** What the tutorial said about this file, per step (materials.json `notes`). */
  notes: Array<{ node: string; step: string; note: string }>;
  /** The task's steps, with the content units each covers. */
  steps: Array<{ id: string; title: string; covers?: string[] }>;
  /** The step plan's units, each with the verbatim quote it was read from. */
  units: Array<{ id: string; title: string; quote?: string }>;
}): FileDigest {
  const blocks = textToBlocks(input.extractedText.slice(0, 60_000));
  const sections = blocks.filter((block) => block.t === "h").map(blockText).slice(0, 8);
  const text = squash(input.extractedText);
  // A unit counts as read from this file when its quote is in it.
  const fromHere = new Set(input.units.filter((unit) => unit.quote && squash(unit.quote).length >= 4 && text.includes(squash(unit.quote))).map((unit) => unit.id));
  const byStep = new Map<string, { stepId?: string; title: string; notes: string[] }>();
  for (const step of input.steps) {
    if ((step.covers ?? []).some((id) => fromHere.has(id))) byStep.set(step.title, { stepId: step.id, title: step.title, notes: [] });
  }
  for (const note of input.notes) {
    const step = input.steps.find((item) => item.title.trim() === note.step.trim());
    const entry = byStep.get(note.step) ?? { ...(step ? { stepId: step.id } : {}), title: note.step, notes: [] };
    // The same note written for several steps is shown once, under the first.
    if (![...byStep.values()].some((other) => other.notes.some((existing) => squash(existing) === squash(note.note)))) entry.notes.push(note.note);
    byStep.set(note.step, entry);
  }
  const order = new Map(input.steps.map((step, index) => [step.title, index]));
  return { kindLabel: KIND_LABEL[materialKind(input.fileName)], characters: input.extractedText.length, sections,
    steps: [...byStep.values()].sort((a, b) => (order.get(a.title) ?? 99) - (order.get(b.title) ?? 99)) };
}
