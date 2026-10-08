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

export const DEFAULT_TIERS: Record<RouteTier, ModelRoute> = {
  top: { model: "gpt-5.6-sol", effort: "medium" },
  mid: { model: "gpt-5.6-terra", effort: "high" },
  low: { model: "gpt-5.6-luna", effort: "high" }
};

/** Keyed by the Skill's own name, without the `crossline:` plugin prefix. */
export const SKILL_TIERS: Record<string, RouteTier> = {
  "crossline-onboarding": "top",
  "crossline-milestone-architect": "top",
  "crossline-goal-backplanner": "top",
  "crossline-flywheel-scout": "top",
  "crossline-automation-stripper": "mid",
  "crossline-manualbook-designer": "top",
  "crossline-material-researcher": "mid",
  "crossline-material-writer": "mid",
  "crossline-step-planner": "mid",
  "crossline-validation-reviewer": "low",
  "crossline-progress-judge": "mid",
  "crossline-milestone-gate": "mid",
  "crossline-weekly-insight": "mid",
  "crossline-due-diligence": "mid",
  "crossline-background-facts": "low",
  "crossline-plan-explainer": "low",
  "crossline-assistant": "low",
  // The assistant that works on the person's machine: coding and multi-step work, so the strongest tier, and never stepped down.
  "crossline-agent": "top"
};

/**
 * Where a Skill needs something other than its tier's default. Empty today: every Skill runs as its tier says. The
 * mechanism stays so one Skill can think less (or more) without moving tier.
 */
export const SKILL_OVERRIDES: Record<string, Partial<ModelRoute>> = {};

/**
 * Skills that never step down a tier when the budget is tight. The gate decides whether work counts as done and
 * the analysis decides what a capture is: a weaker reading of either is a wrong answer, not a cheaper one.
 */
export const NEVER_DOWNGRADED = new Set(["crossline-milestone-gate", "crossline-automation-stripper", "crossline-agent"]);

const TIERS: RouteTier[] = ["top", "mid", "low"];
const skillKey = (skillName: string) => skillName.replace(/^crossline:/, "");

/** `model` or `model:effort`. */
function parseRoute(value: string | undefined): ModelRoute | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const [model, effort] = text.split(":");
  return model ? { model: model.trim(), ...(effort?.trim() ? { effort: effort.trim() } : {}) } : undefined;
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
