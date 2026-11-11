import { METHOD_SLOT } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

/**
 * What the person's own words say about how they work, for the drill-form check (`packages/core/src/drill-forms.ts`, the owner's rule
 * of 2026-11-10): every confirmed fact (their interview answers, the 做事方法 slots, the answers they gave on a task), the preferences they
 * stated, and — for a task they captured themselves — the words they captured it in. Assumptions (「假设：…」) and the model's own
 * inferences are not the person's words and back nothing. `methodKnown` says a confirmed fact already records how they work.
 */
export function drillBackingFor(store: CrosslineStore, workspaceId: string, options: { captureId?: string; scopes?: string[] } = {}):
  { backing: string[]; methodKnown: boolean } {
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed");
  const capture = options.captureId ? store.listCaptures(workspaceId).find((item) => item.id === options.captureId) : undefined;
  const preferences = options.scopes?.length ? store.preferenceLines(workspaceId, options.scopes, 40) : [];
  return {
    backing: [...facts.map((fact) => fact.value), ...preferences, ...(capture ? [capture.title, capture.context] : [])].filter(Boolean),
    methodKnown: facts.some((fact) => METHOD_SLOT.test(fact.slot) && fact.value.trim().length > 0)
  };
}
