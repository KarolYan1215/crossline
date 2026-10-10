/**
 * What a pay-per-use (API key) account has spent this month, for its monthly cap (decided 2026-10-10: $10 unless the person sets
 * another). Prices of the routed model versions are not published anywhere this repo can check, so one rate per million tokens is
 * used for all of them, set high on purpose: an estimate that runs over stops background work early, one that runs under spends the
 * person's money. `CROSSLINE_API_PRICE_PER_MTOK="input:output"` replaces it with the real figures. Reasoning tokens bill as output.
 */
export const DEFAULT_PRICE_PER_MTOK = { input: 10, output: 40 };

export function pricePerMTok(env: NodeJS.ProcessEnv = process.env): { input: number; output: number } {
  const [input, output] = (env.CROSSLINE_API_PRICE_PER_MTOK ?? "").split(":").map(Number);
  return input && output && input > 0 && output > 0 ? { input, output } : DEFAULT_PRICE_PER_MTOK;
}

export function spentFor(usage: Array<{ inputTokens: number; outputTokens: number; reasoningTokens: number }>, env: NodeJS.ProcessEnv = process.env): number {
  const price = pricePerMTok(env);
  return usage.reduce((sum, row) => sum + (row.inputTokens * price.input + (row.outputTokens + row.reasoningTokens) * price.output) / 1_000_000, 0);
}
