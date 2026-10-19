import { expect, test } from "vitest";
import { conformanceCases, SKILL_NEEDS, summarizeConformance } from "./provider-conformance";
import { chooseSponsorModel, dominatedCandidates, evaluationYuanPerRun, parseSponsorModels, hoursToOffPeakEnd, sponsorFallbacks, sponsorModelForSkill, sponsorMonth, sponsorOffPeak, sponsorSpend, SPONSOR_SIMPLE_SKILLS } from "./sponsor";

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
  const onboardingCase = "ONBOARDING_EXTRACT_SCHEMA";
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

test("a thinking variant is priced as its base model, and only off or a token count is a variant", async () => {
  const { sponsorSpend, thinkingVariant } = await import("./sponsor");
  expect(thinkingVariant("deepseek-ai/DeepSeek-V4.1-Flash@think:off")).toEqual({ base: "deepseek-ai/DeepSeek-V4.1-Flash", thinking: { enable: false } });
  expect(thinkingVariant("m@think:99999")).toEqual({ base: "m", thinking: { enable: true, budget: 32768 } });
  expect(thinkingVariant("qwen3:8b")).toEqual({ base: "qwen3:8b" });
  expect(sponsorSpend([{ model: "m@think:2048", inputTokens: 1_000_000, outputTokens: 0 }], [{ model: "m", priceIn: 2, priceOut: 8 }])).toBe(2);
});

test("a simple background Skill runs on the cheapest candidate that passed it; the rest stay on the chosen model; fallbacks exclude the model", () => {
  const models = parseSponsorModels("main=2:8:1024,flash=0.5:2:1024,mid=1:4:1024,short=0.1:0.1:32");
  const classifierCase = SKILL_NEEDS["crossline-calendar-classifier"]!.schemas[0]!;
  const evaluations = [
    { model: "main", record: record("main"), yuanPerRun: 0.05 },
    { model: "flash", record: record("flash"), yuanPerRun: 0.01 },
    { model: "mid", record: record("mid"), yuanPerRun: 0.02 },
    { model: "short", record: record("short"), yuanPerRun: 0.001 }
  ];
  expect(SPONSOR_SIMPLE_SKILLS).toContain("crossline-mail-triage");
  expect(sponsorModelForSkill("crossline-calendar-classifier", "main", models, evaluations)).toBe("flash");
  expect(sponsorModelForSkill("crossline-step-planner", "main", models, evaluations)).toBe("main");
  // A candidate that failed the Skill's own case is not used for it.
  const failing = evaluations.map((item) => item.model === "flash" ? { ...item, record: record("flash", classifierCase) } : item);
  expect(sponsorModelForSkill("crossline-calendar-classifier", "main", models, failing)).toBe("mid");
  // Next models for a person's turn refused for load: cheapest first, never the one refused (a thinking variant counts as its base).
  expect(sponsorFallbacks("crossline-onboarding", "main@think:off", models, evaluations)).toEqual(["flash", "mid"]);
});

test("the off-peak hours are 02:00–08:00 Beijing time, and the time to their end counts to this window or the next", () => {
  // 18:00 UTC is 02:00 in Beijing; 23:59 UTC is 07:59; 00:00 UTC is 08:00.
  expect(sponsorOffPeak(new Date("2026-10-19T18:00:00Z"))).toBe(true);
  expect(sponsorOffPeak(new Date("2026-10-19T23:59:00Z"))).toBe(true);
  expect(sponsorOffPeak(new Date("2026-10-20T00:00:00Z"))).toBe(false);
  expect(sponsorOffPeak(new Date("2026-10-19T17:59:00Z"))).toBe(false);
  expect(hoursToOffPeakEnd(new Date("2026-10-19T20:00:00Z"))).toBe(4);
  // 09:00 Beijing (01:00 UTC): the next window ends tomorrow at 08:00 Beijing, 23 hours on.
  expect(hoursToOffPeakEnd(new Date("2026-10-20T01:00:00Z"))).toBe(23);
  // 01:00 Beijing (17:00 UTC): this night's window, 7 hours on.
  expect(hoursToOffPeakEnd(new Date("2026-10-19T17:00:00Z"))).toBe(7);
});

test("a candidate another beats on pass rate, cost and slowest run is off the frontier; a trade-off keeps both", () => {
  const models = parseSponsorModels("a=2:8:1024,b=8:28:1024,c=0.8:2.8:1024,d=1:4:1024");
  const tokens = { input: 1_000_000, cached: 0, output: 100_000, runs: 10 };
  const record = (passRate: number, p95Ms: number) => ({ providerId: "sponsor", model: "", runtimeVersion: "r", ranAt: "", passRate, repairRate: 0, p95Ms, runs: [], failures: [] });
  const evaluations = [
    { model: "a", record: record(1, 38_000), yuanPerRun: 0, tokens, version: 7 },
    // Dearer and slower at the same pass rate.
    { model: "b", record: record(1, 56_000), yuanPerRun: 0, tokens, version: 7 },
    // Cheaper but fails more and is slower: a trade-off, on the frontier.
    { model: "c", record: record(0.976, 145_000), yuanPerRun: 0, tokens, version: 7 },
    // Would be beaten by "a", but was measured another way.
    { model: "d", record: record(0.9, 90_000), yuanPerRun: 0, tokens, version: 6 },
    // Never reached a model (a spent key): compares with nothing.
    { model: "x", record: record(0, 0), yuanPerRun: 0, tokens: { ...tokens, input: 0 }, version: 7 }
  ];
  expect([...dominatedCandidates(evaluations, models)]).toEqual([["b", "a"]]);
});
