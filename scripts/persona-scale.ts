/**
 * The scale page as a played person fills it before the interview (2026-11-27, docs/plans/condense-1127.md A7): every item of
 * `PROFILE_ITEMS` (IPIP-NEO-120 and TwIVI), in batches, answered in character by Skill `crossline-eval-persona` in its scale mode. The
 * answers come back in the shape the scale route takes (`changeScale` with `action: "answers"`): a score on the item's own points, or
 * null for an item the person left. Shared by `persona-eval.ts` and `onboarding-eval.ts`.
 */
import { PROFILE_ITEMS, pointLabels } from "../packages/core/src/index";

const BATCH = 20;
export const SCALE_PLAYER_SCHEMA = { type: "object", additionalProperties: false, required: ["taps"], properties: {
  taps: { type: "array", maxItems: BATCH, items: { type: "object", additionalProperties: false, required: ["itemId", "score"], properties: {
    itemId: { type: "string", minLength: 1, maxLength: 40 }, score: { type: "integer", minimum: 0, maximum: 6 } } } } } };
export type ScaleTaps = { taps: Array<{ itemId: string; score: number }> };

export async function playScale(persona: string, play: (context: Record<string, unknown>) => Promise<ScaleTaps | undefined>): Promise<Array<{ itemId: string; score: number | null }>> {
  const answers: Array<{ itemId: string; score: number | null }> = [];
  for (let at = 0; at < PROFILE_ITEMS.length; at += BATCH) {
    const batch = PROFILE_ITEMS.slice(at, at + BATCH);
    const context = { version: "crossline.eval-persona.scale", persona, items: batch.map((item) => ({ id: item.id, text: item.text, labels: pointLabels(item) })) };
    const taps = new Map(((await play(context))?.taps ?? []).map((tap) => [tap.itemId, tap.score]));
    for (const item of batch) {
      const score = taps.get(item.id);
      answers.push({ itemId: item.id, score: score !== undefined && score >= 1 && score <= item.points ? score : null });
    }
  }
  return answers;
}
