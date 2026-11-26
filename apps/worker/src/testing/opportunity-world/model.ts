import { OPPORTUNITY_NEEDS_SKILL, OPPORTUNITY_READER_SKILL } from "@crossline/core";
import { scriptedRuntime } from "../fake-runtime";
import { PAGE_READINGS, SCENARIOS, watchesFor } from "./scenarios";
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

/**
 * Milestones the input marks as reached, however a track names it (status, a flag, full progress), or whose work the line's `progress`
 * says was accepted or judged (§17.4's node: the work order is named after the milestone it serves).
 */
function reached(milestones: unknown, progress: unknown): Set<string> {
  const out = new Set<string>();
  const nodes = (Array.isArray(progress) ? progress as Array<Record<string, unknown>> : [])
    .filter((item) => item.type === "evidence.accepted" || item.type === "milestone_gate.judged").map((item) => String(item.title ?? ""));
  for (const item of Array.isArray(milestones) ? milestones as Array<Record<string, unknown>> : []) {
    if (nodes.some((title) => title && title === String(item.title ?? ""))) out.add(String(item.id));
    const status = String(item.status ?? "");
    if (["done", "met", "accepted", "achieved", "reached", "completed"].includes(status) || item.done === true || item.met === true || Number(item.progress) >= 1)
      out.add(String(item.id));
  }
  return out;
}

const readingsFor = (choices: { faithful: Reading[]; adversarial?: Reading[] | undefined; injectedText?: string | undefined } | undefined, persona: Persona,
  text = "") =>
  !choices ? [] : persona === "adversarial" && choices.adversarial && (!choices.injectedText || text.includes(choices.injectedText)) ? choices.adversarial
    : choices.faithful;

/**
 * The classifier's part of a reading (docs/opportunity-agent.md §18): both personas tag the find with the line its scenario plants it
 * under (else the watch's), anchored on that line's goal — the world tests what reaches the person, not the classifier's judgement.
 */
const tagged = (item: Reading, input: Record<string, unknown>) => {
  if ((item as { lines?: unknown }).lines) return item;
  const lineId = SCENARIOS.find((scenario) => scenario.urls.includes(item.url))?.lineId ?? String((input.watch as { line?: string } | undefined)?.line ?? "");
  return { ...item, type: item.kind === "application" ? "program" : "event", reason: item.title,
    lines: lineId ? [{ lineId, confidence: 0.8, reason: item.title, anchors: ["goal"] }] : [] };
};

const EU = ["austria", "belgium", "france", "germany", "italy", "netherlands", "spain", "sweden", "poland", "portugal", "ireland", "denmark", "finland"];
/**
 * The reader's fit (2026-11-25) as a careful model gives it, from the reading's own terms and the person in the input: a stated enrolment
 * term for another degree is the wrong stage; a citizenship, residence or age bar the person does not clear is not reachable; a term only
 * a person can judge is a partial requirement. A reading may carry its own fit (ground truth fixed in the scenario), which wins.
 */
function fitFor(item: Reading, input: Record<string, unknown>) {
  if (item.fit) return item.fit;
  const facts = new Map(((input.person as { facts?: Array<{ slot: string; value: string }> } | undefined)?.facts ?? []).map((fact) => [fact.slot, fact.value]));
  const stageText = (facts.get("apply.degree_stage") ?? "").toLowerCase();
  const stage = /ph\.?d|doctor/.test(stageText) ? "phd" : /master/.test(stageText) ? "masters" : /undergrad|bachelor/.test(stageText) ? "undergraduate" : "";
  let stageFit: "fits" | "wrong_stage" = "fits", reachable = true;
  const partialRequirements: string[] = [];
  for (const term of item.eligibility) {
    const values = (term.accepts?.values ?? []).map((value) => value.toLowerCase());
    if (term.dim === "degree_stage" && stage && values.length) {
      const ok = values.includes(stage) || (values.includes("graduate") && (stage === "phd" || stage === "masters"));
      if (!ok) stageFit = "wrong_stage";
    } else if (term.dim === "citizenship") {
      const mine = (facts.get("apply.citizenship") ?? "").toLowerCase();
      if (!mine || !values.some((value) => value.includes(mine) || (mine === "united states" && /u\.?s\.?|us /.test(value)))) reachable = false;
    } else if (term.dim === "region") {
      const mine = (facts.get("apply.country") ?? "").toLowerCase();
      if (!mine || !(values.some((value) => value.includes(mine)) || (values.some((value) => /european union|eu /.test(value)) && EU.includes(mine)))) reachable = false;
    } else if (term.dim === "age") {
      const age = Number(facts.get("apply.age") ?? NaN);
      const { min = -1, max = -1 } = term.accepts ?? {};
      if (!Number.isFinite(age) || (min >= 0 && age < min) || (max >= 0 && age > max)) reachable = false;
    } else if (term.dim === "other") partialRequirements.push(term.rule);
  }
  return { stageFit, directionFit: "same" as const, reachable, partialRequirements, agentCanPrepare: partialRequirements.length ? ["申请材料草稿"] : [], why: item.title };
}

/** The answer a turn's input gets; exported for tracks that drive the Skills through a runtime of their own. */
export function answerFor(world: World, persona: Persona, input: Record<string, unknown>): string {
  if (typeof input.version === "string" && input.version.startsWith("crossline.opportunity-watches")) {
    const line = input.line as { id: string };
    return JSON.stringify({ watches: watchesFor(line.id, reached(input.milestones, input.progress)), blocked: "" });
  }
  const pages = (input.pages as Array<{ pageId: string; url: string; text?: string }> | undefined) ?? [];
  if (pages.length) {
    const items = pages.flatMap((page) => readingsFor(PAGE_READINGS[page.url], persona, page.text).map((item) => ({ ...tagged(item, input), fit: fitFor(item, input), pageId: page.pageId })));
    return JSON.stringify({ items, blocked: items.length ? "" : "no opening on these pages" });
  }
  const query = String((input.search as { query?: string } | undefined)?.query ?? "");
  const items = searchWorld(world, query).flatMap((hit) => persona === "adversarial" && hit.adversarial ? hit.adversarial : hit.reading ? [hit.reading] : [])
    .map((item) => ({ ...tagged(item, input), fit: fitFor(item, input), pageId: "" }));
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
