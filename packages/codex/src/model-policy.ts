/**
 * Which model and reasoning effort a Skill runs on, and how that bends when the budget is tight.
 *
 * Codex quota is the scarce resource here, and Skills differ enormously in how much thinking they need:
 * interviewing a person and designing milestones is worth the best model, deciding whether evidence
 * matches a contract is a checking job, and extracting dates from a syllabus is plain reading. Every run
 * used the runtime's single default, so the cheapest job cost the same as the hardest.
 *
 * The table is one place on purpose. Swapping a tier to another model — including a non-OpenAI one served
 * through an OpenAI-compatible Responses endpoint — is a change to `DEFAULT_TIERS` or an environment
 * override, never a change to a runner.
 */
import { skillBase, skillKey as keyOf, type EffortPreference } from "@crossline/core";

export type ModelRoute = {
  model: string; effort?: string;
  /** How many times a rejected answer may be sent back. A weaker model needs more; the default is two. */
  maxRepairs?: number;
};
export type RouteTier = "top" | "mid" | "low";
/** What the account's remaining quota allows, as `budgetPolicy` reads it. */
export type SpendMode = "normal" | "economy" | "manual_core_only";

// Three models by Codex credit price (2026-11-25, docs/plans/harness-1125.md §8). Credits per 1M tokens, input/output, from
// learn.chatgpt.com/docs/pricing: gpt-5.6-terra 50/300 (the old single model, two generations behind), gpt-6.2-sol 50/250,
// gpt-6.1-terra 25/125, gpt-6-luna 2.5/12.5. Top costs what every run used to, mid half, low about a twentieth. The 2026-10-20 single-model
// table existed because the old sol cost several times terra; that is no longer so. A model the account does not list — the backend also
// leaves out a model newer than the runtime (gpt-6.2-sol needs Codex 0.166.0) — falls to the newest listed one of its family, then down
// the ladder (`fitRoute`).
export const DEFAULT_TIERS: Record<RouteTier, ModelRoute> = {
  top: { model: "gpt-6.2-sol", effort: "medium" },
  mid: { model: "gpt-6.1-terra", effort: "medium" },
  // Luna's own recommended starting effort is high (learn.chatgpt.com/docs/models).
  low: { model: "gpt-6-luna", effort: "high" }
};

/**
 * Keyed by the Skill's own name without its plugin prefix, and for a merged Skill by `skill:mode` (2026-11-27, docs/plans/condense-1127.md
 * §B): each mode keeps the tier the Skill it was before had. A name with a mode not listed here falls back to the Skill's own key.
 */
export const SKILL_TIERS: Record<string, RouteTier> = {
  "crossline-onboarding": "top",
  // The interview's second layer (2026-10-19): facts, dates and line attributes from numbered sentences, and the portrait's
  // inferences the observation cards are made from. Top since 2026-11-17 (the owner: the interview gets the runtime's full model).
  "crossline-onboarding-extract": "top",
  // An interview research thread (2026-11-12): web lookups and a short sourced conclusion. Top since 2026-11-17, like the extraction.
  "crossline-research:onboarding": "top",
  "crossline-milestone-architect:design": "top",
  "crossline-cross-line-planner:artifacts": "top",
  // Reads drafts critically for what could keep them from being reached; a judgement, not a lookup.
  "crossline-milestone-review:risk": "mid",
  "crossline-goal-backplanner:backplan": "top",
  "crossline-cross-line-planner:flywheel": "top",
  "crossline-automation-stripper": "mid",
  "crossline-task-planner:manual": "top",
  "crossline-research:material": "mid",
  "crossline-material-writer": "mid",
  "crossline-task-planner:steps": "mid",
  "crossline-task-planner:archetype": "mid",
  "crossline-validation-reviewer": "low",
  "crossline-evidence-judge:progress": "mid",
  "crossline-evidence-judge:deliverable": "mid",
  // The execution gates (docs/plans/execution-gates-1124.md §四): judgements against evidence, so a reasoning tier; the drill grades code.
  "crossline-evidence-judge:completion": "mid",
  "crossline-focus:priority": "mid",
  "crossline-focus:front": "mid",
  "crossline-milestone-review:admission": "mid",
  "crossline-weekly-review:setback": "mid",
  "crossline-weekly-review:attention": "mid",
  "crossline-outward-check:pending": "low",
  "crossline-outward-check:week": "low",
  "crossline-gate-drill": "mid",
  "crossline-concierge": "low",
  "crossline-goal-backplanner:title": "low",
  "crossline-line-filer:calendar": "low",
  "crossline-line-filer:folder": "low",
  "crossline-capture-digest:source": "low",
  // 拟计时: which open task a stretch of screen time was for, from its window titles (time-drafts.ts). A filing, not a judgement.
  "crossline-line-filer:time": "low",
  "crossline-capture-digest:recording": "low",
  // A note's pictures and video frames into words and their visible text, many small runs (note-media.ts): the cheap tier.
  "crossline-media-describer": "low",
  "crossline-favourite-topics": "low",
  "crossline-milestone-architect:split": "low",
  // The person's own rules for a line: what every later run on that line follows, so read carefully, not cheaply.
  "crossline-line-method:rules": "mid",
  "crossline-research:skills": "mid",
  "crossline-portrait:report": "top",
  // Only the say–do part of the report, rewritten against the record; its caller asks for the mid tier itself (`tier`).
  "crossline-portrait:gap": "top",
  "crossline-portrait:narrative": "top",
  "crossline-portrait:figure": "low",
  "crossline-eval-persona": "low",
  // Test-only: measures a model connection (provider-conformance.ts); always given the provider under test explicitly.
  "crossline-conformance": "low",
  "crossline-evidence-judge:milestone": "mid",
  // Filling a registration form (docs/opportunity-agent.md §10): one page's actions, and an independent read of what is about to be
  // submitted. Mid: a wrong mapping costs the person a correction, and the rules catch what may not be done either way.
  "crossline-form-page:fill": "mid",
  "crossline-outward-check:form": "mid",
  "crossline-form-page:observe": "mid",
  "crossline-form-page:browser": "mid",
  "crossline-weekly-review:insight": "mid",
  "crossline-research:diligence": "mid",
  // The weekly energy-advice review: reads research and argues with a rule, once a week.
  "crossline-schedule-advisor:energy": "mid",
  // Once after the interview: reads the person's habits and the field's current practice, and sets how every later plan is shaped.
  "crossline-line-method:research": "top",
  // The opportunity agent (docs/opportunity-agent.md §5): working out what outside gates a line's goal must pass reads the field and the
  // person's whole line, so the top tier; reading one found page into terms and dates is a careful extraction, the middle one.
  "crossline-research:needs": "top",
  "crossline-page-reader:opportunity": "mid",
  // Finding the official visa page and copying its sentences: a lookup; code checks every quote and reads the days itself.
  "crossline-page-reader:visa": "low",
  // `web_research`'s search run: queries in, pages out, nothing to judge (docs/plans/harness-1125.md §10).
  "crossline-web-scout": "low",
  // Whether a tainted run's searches carry something about a person (docs/plans/harness-1125.md §18): a short reading of a few lines.
  "crossline-query-review": "low",
  // Brokerage quotes for the ledger's holdings (docs/ledger-wealth.md §2): one connector call per symbol, the number checked by code.
  "crossline-quote-reader": "low",
  "crossline-capture-digest:background": "low",
  "crossline-schedule-advisor:explain": "low",
  // The assistant that works on the person's machine: coding and multi-step work, so the strongest tier, and never stepped down.
  "crossline-agent:shell": "top",
  // The assistant without a shell: reading, writing and organising through Crossline's functions, on any model.
  "crossline-agent:functions": "mid",
  // New mail sorted from headers and opening lines: many small runs, so the cheap tier.
  "crossline-inbox-triage:mail": "low",
  "crossline-inbox-triage:import": "low",
  // One short answer to one message the person must reply to, structured and without tools: the cheap tier (docs/personal-agent.md §3.1).
  "crossline-mail-reply-drafter": "low",
  // Dictated text checked against the person's own names while they wait, a few seconds per clip: the cheap tier.
  "crossline-dictation-corrector": "low",
  // One request in words into a trigger and steps, once per automation.
  "crossline-automation-designer": "mid"
};

/**
 * Where a Skill needs something other than its tier's default, so one Skill can think less (or more) without moving tier. The one input
 * box answers while the person waits: measured on the thirty-sentence replay (`scripts/concierge-replay.ts`, 2026-10-09), medium effort
 * read as well as high (29 and 28 of 30, the misses not the same sentences) with a median of 11.4 s against 12.3 s. That override lowered
 * luna's high effort; on the one-model table the low tier is already below medium, so the input box takes its tier's effort as it is.
 */
export const SKILL_OVERRIDES: Record<string, Partial<ModelRoute>> = {};

/**
 * Skills that never step down a tier when the budget is tight. The gate decides whether work counts as done and
 * the analysis decides what a capture is: a weaker reading of either is a wrong answer, not a cheaper one.
 */
export const NEVER_DOWNGRADED = new Set(["crossline-evidence-judge:milestone", "crossline-automation-stripper", "crossline-agent:shell",
  // The interview (2026-11-17, the owner: no limit on the model in the interview, at least as free as Codex itself): its dialogue, its
  // extraction and research threads and the portrait it ends in keep their tier when the budget is tight.
  "crossline-onboarding", "crossline-onboarding-extract", "crossline-research:onboarding", "crossline-portrait:report",
  "crossline-portrait:gap", "crossline-portrait:narrative"]);

const TIERS: RouteTier[] = ["top", "mid", "low"];
/** The key a run's Skill name is looked up by: `skill:mode` when the table has it, else the Skill's own (`crossline:` or `crossline-personal:` dropped). */
const skillKey = (skillName: string) => {
  const key = keyOf(skillName);
  return key in SKILL_TIERS ? key : keyOf(skillBase(skillName));
};

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
/** `model` or `model:effort`. Only a known effort counts as one: other providers' model ids carry colons of their own (`qwen3:8b`). */
export function parseRoute(value: string | undefined): ModelRoute | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const at = text.lastIndexOf(":");
  const effort = at > 0 ? text.slice(at + 1).trim() : "";
  const model = EFFORTS.has(effort) ? text.slice(0, at).trim() : text;
  return model ? { model, ...(EFFORTS.has(effort) ? { effort } : {}) } : undefined;
}

export function tierRoutes(env: NodeJS.ProcessEnv = process.env): Record<RouteTier, ModelRoute> {
  const routes = { ...DEFAULT_TIERS };
  for (const tier of TIERS) {
    const override = parseRoute(env[`CROSSLINE_MODEL_${tier.toUpperCase()}`]);
    if (override) routes[tier] = override;
  }
  return routes;
}

export function tierForSkill(skillName: string): RouteTier | undefined {
  return SKILL_TIERS[skillKey(skillName)];
}

/** One step down: the top tier falls to the middle, the middle to the low, the low stays. */
const stepDown = (tier: RouteTier): RouteTier => tier === "top" ? "mid" : "low";

/**
 * The route for a Skill, or `undefined` to leave the choice to the runtime.
 *
 * An unknown Skill gets no route rather than a guess: pinning an unlisted job to some tier would be an
 * invented decision, and the runtime's default is at least what it did before. Routing can be switched
 * off wholesale with `CROSSLINE_MODEL_ROUTING=off` (for a runtime or account that lacks these models).
 *
 * In `economy` mode a Skill steps down one tier unless it is in `NEVER_DOWNGRADED`: the work still gets done,
 * on a cheaper model, instead of being refused when the quota is nearly gone. A per-Skill environment override
 * (`CROSSLINE_ROUTE_<SKILL>` as `model[:effort]`) wins over everything, because someone set it on purpose.
 */
export function routeForSkill(skillName: string, env: NodeJS.ProcessEnv = process.env, mode: SpendMode = "normal"): ModelRoute | undefined {
  if (env.CROSSLINE_MODEL_ROUTING?.trim().toLowerCase() === "off") return undefined;
  const key = skillKey(skillName);
  const pinned = parseRoute(env[`CROSSLINE_ROUTE_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]);
  if (pinned) return pinned;
  const tier = SKILL_TIERS[key];
  if (!tier) return undefined;
  const routes = tierRoutes(env);
  const effective = mode === "economy" && !NEVER_DOWNGRADED.has(key) ? stepDown(tier) : tier;
  // An override describes the Skill's own tier; once the Skill has stepped down it takes the lower tier as it is.
  return effective === tier ? { ...routes[effective], ...SKILL_OVERRIDES[key] } : { ...routes[effective] };
}

const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh"];
/** With no catalogue to say what the model takes, the middle three: every model this app routes to takes them. */
const SAFE_EFFORTS = ["low", "medium", "high"];
/**
 * The person's 模型强度 applied to a route: its effort one step lower or higher, to the nearest effort the model takes (`supported`, from
 * the account's catalogue). A route without an effort, or with none further that way, stays as it is.
 */
export function shiftEffort(route: ModelRoute | undefined, preference: EffortPreference, supported?: string[]): ModelRoute | undefined {
  if (!route?.effort || preference === "default") return route;
  const from = EFFORT_LADDER.indexOf(route.effort);
  if (from < 0) return route;
  const takes = supported?.length ? supported : SAFE_EFFORTS;
  const step = preference === "higher" ? 1 : -1;
  for (let at = from + step; at >= 0 && at < EFFORT_LADDER.length; at += step) {
    if (takes.includes(EFFORT_LADDER[at]!)) return { ...route, effort: EFFORT_LADDER[at]! };
  }
  return route;
}
