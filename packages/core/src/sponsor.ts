import { admittedSkills, THIRD_PARTY_CAPABILITIES, type ConformanceRecord, type ProviderCapabilities } from "./provider-conformance";

/**
 * The developer's model for invited accounts (2026-10-18, the owner's decision): accounts that redeemed an invite code run every Skill on
 * the owner's SiliconFlow key, through the same gateway and conformance check as any provider, capped at ¥30 a month each. Which model
 * is chosen by measurement: every candidate is put through the conformance cases, and the cheapest one per run among those that pass the
 * interview and both critical Skills nearly as well as the best is used — the order of the list breaks a tie (DeepSeek V4.1 first).
 */
export type SponsorModel = {
  model: string;
  /** Yuan per million tokens, input and output (reasoning is part of output). */
  priceIn: number; priceOut: number;
  /** The context window in thousands of tokens, when stated. */
  contextK?: number;
  /** Yuan per million input tokens served from the provider's cache, when it prices them apart; else they bill as input. */
  priceCached?: number;
};
export const SPONSOR_MONTHLY_CAP_CNY = 30;
/** A model this much below the best pass rate still counts as "as good" when comparing prices. */
export const SPONSOR_PASS_MARGIN = 0.05;
/** The interview needs the long context of a full history plus every file. */
export const SPONSOR_MIN_CONTEXT_K = 128;
const REQUIRED_SKILLS = ["crossline-onboarding", "crossline-onboarding-extract", "crossline-automation-stripper", "crossline-milestone-gate"];

/**
 * `model=in:out[:ctxK[:cached]],…` (`CROSSLINE_SPONSOR_MODELS`), yuan per million tokens as SiliconFlow lists them. A model priced by time
 * of day is given its peak price: an estimate that runs over stops an account early, one that runs under spends the owner's money.
 */
export function parseSponsorModels(text: string | undefined): SponsorModel[] {
  return (text ?? "").split(",").map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    const at = part.lastIndexOf("=");
    const model = (at > 0 ? part.slice(0, at) : part).trim();
    const [priceIn, priceOut, contextK, priceCached] = (at > 0 ? part.slice(at + 1) : "").split(":").map(Number);
    if (!model || !(priceIn! > 0) || !(priceOut! > 0)) return [];
    return [{ model, priceIn: priceIn!, priceOut: priceOut!, ...(contextK! > 0 ? { contextK: contextK! } : {}),
      ...(priceCached! >= 0 && priceCached! < priceIn! ? { priceCached: priceCached! } : {}) }];
  });
}

/**
 * Token counts as the runtime reports them: `inputTokens` includes the cached ones and `outputTokens` includes reasoning (Codex's
 * `blended_total` is non-cached input + output), so reasoning is never billed a second time.
 */
export type UsageForPrice = { model: string; inputTokens: number; cachedInputTokens?: number; outputTokens: number };

/** Yuan for one model's tokens at its listed prices. */
export function tokenYuan(usage: Omit<UsageForPrice, "model">, price: SponsorModel): number {
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  return ((usage.inputTokens - cached) * price.priceIn + cached * (price.priceCached ?? price.priceIn) + usage.outputTokens * price.priceOut) / 1_000_000;
}

/** Yuan spent on the sponsor's models; rows on any other model (the account's own ChatGPT) are not counted. */
export function sponsorSpend(usage: UsageForPrice[], models: SponsorModel[]): number {
  const byName = new Map(models.map((model) => [model.model, model]));
  return usage.reduce((sum, row) => {
    const price = byName.get(row.model);
    return price ? sum + tokenYuan(row, price) : sum;
  }, 0);
}

/** The first moment of the current calendar month (UTC), and of the next one: the cap's window. */
export function sponsorMonth(now: Date): { start: string; next: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString(), next: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

/**
 * One candidate's measurement. `tokens` are the evaluation's totals, so the cost per run follows the prices in the environment and a
 * price change needs no new test; `yuanPerRun` is what was computed when it ran (the only figure records from before tokens were kept have).
 */
export type SponsorEvaluation = {
  model: string; record: ConformanceRecord; yuanPerRun: number;
  tokens?: { input: number; cached: number; output: number; runs: number };
  /** The measuring code's version (`SPONSOR_EVAL_VERSION` in the worker); older records are measured again. */
  version?: number;
  /** The sample interview's version (`SPONSOR_DIALOGUE_VERSION`); an older one has only its sample interview run again. */
  dialogueVersion?: number;
};

/** Yuan per conformance run at the current prices. */
export function evaluationYuanPerRun(evaluation: SponsorEvaluation, models: SponsorModel[]): number {
  const price = models.find((model) => model.model === evaluation.model);
  const tokens = evaluation.tokens;
  if (!price || !tokens || !tokens.runs) return evaluation.yuanPerRun;
  return Math.round((tokenYuan({ inputTokens: tokens.input, cachedInputTokens: tokens.cached, outputTokens: tokens.output }, price) / tokens.runs) * 10_000) / 10_000;
}

/**
 * The model to use, or undefined while none passes. Among the candidates that serve the interview and both critical Skills and have the
 * context: those within `SPONSOR_PASS_MARGIN` of the best pass rate, the cheapest per run; ties go to the earlier one in the list.
 */
export function chooseSponsorModel(models: SponsorModel[], evaluations: SponsorEvaluation[],
  capabilities: ProviderCapabilities = THIRD_PARTY_CAPABILITIES): SponsorEvaluation | undefined {
  const order = new Map(models.map((model, index) => [model.model, index]));
  const fit = evaluations.filter((evaluation) => {
    const model = models.find((item) => item.model === evaluation.model);
    if (!model || (model.contextK !== undefined && model.contextK < SPONSOR_MIN_CONTEXT_K)) return false;
    const admitted = new Set(admittedSkills(evaluation.record, capabilities));
    return REQUIRED_SKILLS.every((skill) => admitted.has(skill));
  });
  if (!fit.length) return undefined;
  const best = Math.max(...fit.map((evaluation) => evaluation.record.passRate));
  const cost = (evaluation: SponsorEvaluation) => evaluationYuanPerRun(evaluation, models);
  const pick = fit.filter((evaluation) => evaluation.record.passRate >= best - SPONSOR_PASS_MARGIN)
    .sort((a, b) => cost(a) - cost(b) || (order.get(a.model) ?? 99) - (order.get(b.model) ?? 99))[0];
  return pick && { ...pick, yuanPerRun: cost(pick) };
}
