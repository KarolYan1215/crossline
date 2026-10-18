import { expect, test } from "vitest";
import { conformanceCases, summarizeConformance } from "./provider-conformance";
import { chooseSponsorModel, evaluationYuanPerRun, parseSponsorModels, sponsorMonth, sponsorSpend } from "./sponsor";

const record = (model: string, failCase?: string) => summarizeConformance({ providerId: "sponsor", model, runtimeVersion: "r", ranAt: "2026-10-18T00:00:00Z" },
  conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: item.id !== failCase, repairs: 0, ms: 1000 }))));

test("the list parses prices and context, and skips an entry without prices", () => {
  expect(parseSponsorModels("deepseek-ai/DeepSeek-V4.1=4:16:1024, zai-org/GLM-5.2=4:16, broken, x=0:1")).toEqual([
    { model: "deepseek-ai/DeepSeek-V4.1", priceIn: 4, priceOut: 16, contextK: 1024 }, { model: "zai-org/GLM-5.2", priceIn: 4, priceOut: 16 }]);
});

test("spend counts only the sponsor's models, cached input at its own price and reasoning inside output; the month is the calendar month", () => {
  expect(parseSponsorModels("a=2:8:1024:0.04")).toEqual([{ model: "a", priceIn: 2, priceOut: 8, contextK: 1024, priceCached: 0.04 }]);
  const models = parseSponsorModels("a=2:8:1024:0.5,b=2:8");
  expect(sponsorSpend([{ model: "a", inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 1_000_000 },
    { model: "b", inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 0 },
    { model: "gpt-5.6-terra", inputTokens: 9_000_000, outputTokens: 0 }], models)).toBeCloseTo(0.8 + 0.3 + 8 + 2);
  expect(sponsorMonth(new Date("2026-10-18T12:00:00Z"))).toEqual({ start: "2026-10-01T00:00:00.000Z", next: new Date("2026-11-01T00:00:00.000Z") });
});

test("the cheapest model that serves the interview and both critical Skills is chosen; a failing or short-context one never is", () => {
  const models = parseSponsorModels("deepseek-ai/DeepSeek-V4.1=4:16:1024,zai-org/GLM-5.2=4:16:1024,small=0.5:1:32");
  const onboardingCase = "ONBOARDING_TURN_SCHEMA";
  expect(chooseSponsorModel(models, [
    { model: "deepseek-ai/DeepSeek-V4.1", record: record("deepseek-ai/DeepSeek-V4.1"), yuanPerRun: 0.05 },
    { model: "zai-org/GLM-5.2", record: record("zai-org/GLM-5.2"), yuanPerRun: 0.03 },
    { model: "small", record: record("small"), yuanPerRun: 0.001 }
  ])?.model).toBe("zai-org/GLM-5.2");
  // Equal cost: the earlier one in the list.
  expect(chooseSponsorModel(models, [
    { model: "zai-org/GLM-5.2", record: record("zai-org/GLM-5.2"), yuanPerRun: 0.03 },
    { model: "deepseek-ai/DeepSeek-V4.1", record: record("deepseek-ai/DeepSeek-V4.1"), yuanPerRun: 0.03 }
  ])?.model).toBe("deepseek-ai/DeepSeek-V4.1");
  expect(chooseSponsorModel(models, [{ model: "zai-org/GLM-5.2", record: record("zai-org/GLM-5.2", onboardingCase), yuanPerRun: 0.01 }])).toBeUndefined();
});

test("a measurement with token totals is priced at the current prices, so new prices change the choice without a new test", () => {
  const tokens = { input: 10_000_000, cached: 8_000_000, output: 1_000_000, runs: 10 };
  const cheapOutput = parseSponsorModels("x=2:8:1024:0.04,y=8:28:1024:2");
  const evaluations = [{ model: "x", record: record("x"), yuanPerRun: 9, tokens }, { model: "y", record: record("y"), yuanPerRun: 0.01, tokens }];
  // x: (2M×2 + 8M×0.04 + 1M×8)/1e6/10 = 1.232; y: (2M×8 + 8M×2 + 1M×28)/1e6/10 = 6.
  expect(evaluationYuanPerRun(evaluations[0]!, cheapOutput)).toBe(1.232);
  expect(chooseSponsorModel(cheapOutput, evaluations)).toMatchObject({ model: "x", yuanPerRun: 1.232 });
});
