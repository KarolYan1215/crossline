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
export type ModelRoute = {
  model: string; effort?: string;
  /** How many times a rejected answer may be sent back. A weaker model needs more; the default is two. */
  maxRepairs?: number;
};
export type RouteTier = "top" | "mid" | "low";
/** What the account's remaining quota allows, as `budgetPolicy` reads it. */
export type SpendMode = "normal" | "economy" | "manual_core_only";

// One model, three efforts (2026-10-20, the owner: the sol/terra/luna table spent the quota too fast in testing).
export const DEFAULT_TIERS: Record<RouteTier, ModelRoute> = {
  top: { model: "gpt-5.6-terra", effort: "high" },
  mid: { model: "gpt-5.6-terra", effort: "medium" },
  low: { model: "gpt-5.6-terra", effort: "low" }
};

/** Keyed by the Skill's own name, without the `crossline:` plugin prefix. */
export const SKILL_TIERS: Record<string, RouteTier> = {
  "crossline-onboarding": "top",
  // The interview's second layer (2026-10-19): facts, dates and line attributes from numbered sentences. Careful reading, not synthesis.
  "crossline-onboarding-extract": "mid",
  "crossline-milestone-architect": "top",
  "crossline-artifact-planner": "top",
  // Reads drafts critically for what could keep them from being reached; a judgement, not a lookup.
  "crossline-milestone-risk-reviewer": "mid",
  "crossline-goal-backplanner": "top",
  "crossline-flywheel-scout": "top",
  "crossline-automation-stripper": "mid",
  "crossline-manualbook-designer": "top",
  "crossline-material-researcher": "mid",
  "crossline-material-writer": "mid",
  "crossline-step-planner": "mid",
  "crossline-archetype-curator": "mid",
  "crossline-validation-reviewer": "low",
  "crossline-progress-judge": "mid",
  "crossline-concierge": "low",
  "crossline-task-titler": "low",
  "crossline-calendar-classifier": "low",
  "crossline-folder-classifier": "low",
  "crossline-recording-digest": "low",
  // A note's pictures and video frames into words and their visible text, many small runs (note-media.ts): the cheap tier.
  "crossline-media-describer": "low",
  "crossline-favourite-topics": "low",
  "crossline-goal-splitter": "low",
  // The person's own rules for a line: what every later run on that line follows, so read carefully, not cheaply.
  "crossline-insight-compiler": "mid",
  "crossline-skill-scout": "mid",
  "crossline-portrait-writer": "top",
  "crossline-portrait-illustrator": "low",
  "crossline-eval-persona": "low",
  // Test-only: measures a model connection (provider-conformance.ts); always given the provider under test explicitly.
  "crossline-conformance": "low",
  "crossline-milestone-gate": "mid",
  "crossline-weekly-insight": "mid",
  "crossline-due-diligence": "mid",
  // The weekly energy-advice review: reads research and argues with a rule, once a week.
  "crossline-energy-advisor": "mid",
  "crossline-background-facts": "low",
  "crossline-plan-explainer": "low",
  // The assistant that works on the person's machine: coding and multi-step work, so the strongest tier, and never stepped down.
  "crossline-agent": "top",
  // The assistant without a shell: reading, writing and organising through Crossline's functions, on any model.
  "crossline-agent-tools": "mid",
  // New mail sorted from headers and opening lines: many small runs, so the cheap tier.
  "crossline-mail-triage": "low",
  // One short answer to one message the person must reply to, structured and without tools: the cheap tier (docs/personal-agent.md §3.1).
  "crossline-mail-reply-drafter": "low",
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
export const NEVER_DOWNGRADED = new Set(["crossline-milestone-gate", "crossline-automation-stripper", "crossline-agent"]);

const TIERS: RouteTier[] = ["top", "mid", "low"];
const skillKey = (skillName: string) => skillName.replace(/^crossline:/, "");

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
