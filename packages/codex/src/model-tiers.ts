import type { ModelTier } from "@crossline/core";

/**
 * The single place a capability name becomes a concrete model. Business code asks for `routine` or
 * `capable`; swapping the backing model is an environment change, not a code change.
 *
 * Unset means "let the runtime use its own default" rather than a model name invented here — naming a
 * default would silently pin work to a model nobody chose.
 */
export function modelTierMapping(env: NodeJS.ProcessEnv = process.env): Partial<Record<ModelTier, string>> {
  const routine = env.CROSSLINE_MODEL_ROUTINE?.trim();
  const capable = env.CROSSLINE_MODEL_CAPABLE?.trim();
  return { ...(routine ? { routine } : {}), ...(capable ? { capable } : {}) };
}
