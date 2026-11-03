import { OPPORTUNITY_NEEDS_SKILL, OPPORTUNITY_READER_SKILL } from "@crossline/core";
import { scriptedRuntime } from "../fake-runtime";
import { needsFor, PAGE_READINGS } from "./scenarios";
import { searchWorld, type Reading, type World } from "./world";

/**
 * The scripted model for the synthetic world (§17.9 ③), on the shared stand-in runtime. It answers the opportunity Skills from the
 * world's own ground truth, so what is measured is the system around the model, never the model:
 *
 *   faithful     reads every page the way a careful model would;
 *   adversarial  where a plausible model gets a page wrong, gets it wrong that way — it follows a page's injected instructions, projects
 *                last year's date onto this year, invents a date for 「TBD」, keeps only the original of an extended deadline. Code gates
 *                must hold against it.
 *
 * A repair turn (the runner sending a rejection back) is answered with the same reading: a scripted model does not learn.
 */
export type Persona = "faithful" | "adversarial";

/** Milestones the input marks as reached, however a track names it (status, a flag, or full progress). */
function reached(milestones: unknown): Set<string> {
  const out = new Set<string>();
  for (const item of Array.isArray(milestones) ? milestones as Array<Record<string, unknown>> : []) {
    const status = String(item.status ?? "");
    if (["done", "met", "accepted", "achieved", "reached", "completed"].includes(status) || item.done === true || item.met === true || Number(item.progress) >= 1)
      out.add(String(item.id));
  }
  return out;
}

const readingsFor = (choices: { faithful: Reading[]; adversarial?: Reading[] | undefined } | undefined, persona: Persona) =>
  !choices ? [] : persona === "adversarial" && choices.adversarial ? choices.adversarial : choices.faithful;

/** The answer a turn's input gets; exported for tracks that drive the Skills through a runtime of their own. */
export function answerFor(world: World, persona: Persona, input: Record<string, unknown>): string {
  if (typeof input.version === "string" && input.version.startsWith("crossline.opportunity-needs")) {
    const line = input.line as { id: string };
    return JSON.stringify({ needs: needsFor(line.id, reached(input.milestones)), blocked: "" });
  }
  const pages = (input.pages as Array<{ pageId: string; url: string }> | undefined) ?? [];
  if (pages.length) {
    const items = pages.flatMap((page) => readingsFor(PAGE_READINGS[page.url], persona).map((item) => ({ ...item, pageId: page.pageId })));
    return JSON.stringify({ items, blocked: items.length ? "" : "no opening on these pages" });
  }
  const query = String((input.search as { query?: string } | undefined)?.query ?? "");
  const items = searchWorld(world, query).flatMap((hit) => persona === "adversarial" && hit.adversarial ? hit.adversarial : hit.reading ? [hit.reading] : [])
    .map((item) => ({ ...item, pageId: "" }));
  return JSON.stringify({ items, blocked: items.length ? "" : "nothing found" });
}

/** A runtime that knows the opportunity Skills and answers each from the world; usage is reported so cost bookkeeping has numbers. */
export function worldRuntime(world: World, persona: Persona, extraSkills: string[] = [], respondOther?: (input: Record<string, unknown>, prompt: string) => string | undefined) {
  let last = "";
  return scriptedRuntime([OPPORTUNITY_NEEDS_SKILL, OPPORTUNITY_READER_SKILL, ...extraSkills], (prompt) => {
    if (!prompt.startsWith("$")) return last;
    const input = JSON.parse(prompt.slice(prompt.indexOf("{"))) as Record<string, unknown>;
    last = respondOther?.(input, prompt) ?? answerFor(world, persona, input);
    return last;
  }, { usage: { input: 4000, output: 600 } });
}
