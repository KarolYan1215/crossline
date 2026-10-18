import { expect, test } from "vitest";
import { conformanceCases, summarizeConformance } from "./provider-conformance";
import { chooseSponsorModel, parseSponsorModels, sponsorMonth, sponsorSpend } from "./sponsor";

const record = (model: string, failCase?: string) => summarizeConformance({ providerId: "sponsor", model, runtimeVersion: "r", ranAt: "2026-10-18T00:00:00Z" },
  conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: item.id !== failCase, repairs: 0, ms: 1000 }))));

test("the list parses prices and context, and skips an entry without prices", () => {
  expect(parseSponsorModels("deepseek-ai/DeepSeek-V4.1=4:16:1024, zai-org/GLM-5.2=4:16, broken, x=0:1")).toEqual([
    { model: "deepseek-ai/DeepSeek-V4.1", priceIn: 4, priceOut: 16, contextK: 1024 }, { model: "zai-org/GLM-5.2", priceIn: 4, priceOut: 16 }]);
});

test("spend counts only the sponsor's models, reasoning as output; the month is the calendar month", () => {
  const models = parseSponsorModels("a=2:8");
  expect(sponsorSpend([{ model: "a", inputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 500_000 },
    { model: "gpt-5.6-terra", inputTokens: 9_000_000, outputTokens: 0, reasoningTokens: 0 }], models)).toBe(10);
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
