import { expect, test } from "vitest";
import { spendAllows, saverStopsNonCore, type BackgroundSpend } from "./cost";
import { NON_CORE_PURPOSE, inPersonNight, quotaSaverOn, quotaSaverReading, runCost, weightedTokens, zoneWeekStart } from "./quota-saver";
import { parseSponsorModels } from "./sponsor";
import { PUBLIC_SKILL_BATCH_REVIEW_SCHEMA, validatePublicSkillBatchReview } from "./public-skills";
import { structuredOutputProblems } from "./structured-output";

test("weighted cost: uncached input + a tenth of cached input + eight times output; yuan only on the developer's models", () => {
  expect(weightedTokens({ inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 500 })).toBe(2_000 + 800 + 4_000);
  // More cached than input (a runtime quirk) is clamped to the input.
  expect(weightedTokens({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 })).toBe(10);
  const models = parseSponsorModels("deepseek-ai/DeepSeek-V4.1-Flash=1:4:1024:0.1");
  expect(runCost({ model: "gpt-5.6-terra", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, models)).toEqual({ weightedTokens: 1_000_000 });
  const sponsored = runCost({ model: "deepseek-ai/DeepSeek-V4.1-Flash@think:off", inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 }, models);
  expect(sponsored.weightedTokens).toBe(500_000 + 50_000 + 800_000);
  expect(sponsored.yuan).toBeCloseTo(0.5 + 0.05 + 0.4, 6);
});

test("the person's week starts Monday 00:00 in their zone; their night is 23:00–07:00", () => {
  // Wednesday 2026-10-21 15:00 UTC: Chicago's Monday midnight is 05:00 UTC (CDT), Shanghai's is the Sunday 16:00 UTC.
  const now = new Date("2026-10-21T15:00:00Z");
  expect(zoneWeekStart(now, "America/Chicago")).toEqual({ at: "2026-10-19T05:00:00.000Z", day: "2026-10-19" });
  expect(zoneWeekStart(now, "Asia/Shanghai")).toEqual({ at: "2026-10-18T16:00:00.000Z", day: "2026-10-19" });
  // A Monday early morning belongs to that Monday's week; a Sunday night to the week before.
  expect(zoneWeekStart(new Date("2026-10-19T06:00:00Z"), "America/Chicago").day).toBe("2026-10-19");
  expect(zoneWeekStart(new Date("2026-10-19T04:00:00Z"), "America/Chicago").day).toBe("2026-10-12");
  // Chicago leaves daylight time on 2026-11-01: the next Monday's midnight is at 06:00 UTC.
  expect(zoneWeekStart(new Date("2026-11-04T12:00:00Z"), "America/Chicago").at).toBe("2026-11-02T06:00:00.000Z");
  expect(inPersonNight(new Date("2026-10-21T04:30:00Z"), "America/Chicago")).toBe(true); // 23:30
  expect(inPersonNight(new Date("2026-10-21T11:59:00Z"), "America/Chicago")).toBe(true); // 06:59
  expect(inPersonNight(new Date("2026-10-21T12:00:00Z"), "America/Chicago")).toBe(false); // 07:00
  expect(inPersonNight(new Date("2026-10-21T03:59:00Z"), "America/Chicago")).toBe(false); // 22:59
});

test("the saver is on unless turned off; non-core reaches its share past a fifth of the week's weighted cost", () => {
  expect(quotaSaverOn(undefined)).toBe(true);
  expect(quotaSaverOn("on")).toBe(true);
  expect(quotaSaverOn("off")).toBe(false);
  const now = new Date("2026-10-21T15:00:00Z");
  const reading = (nonCore: number, core: number) => quotaSaverReading({ raw: undefined, now, zone: "America/Chicago",
    usage: [{ purpose: NON_CORE_PURPOSE, inputTokens: nonCore, cachedInputTokens: 0, outputTokens: 0 }, { purpose: "", inputTokens: core, cachedInputTokens: 0, outputTokens: 0 }] });
  // The first non-core run of a week may start before any core work.
  expect(reading(0, 0)).toEqual({ on: true, night: false, overShare: false, week: "2026-10-19" });
  expect(reading(20, 80).overShare).toBe(false);
  expect(reading(21, 80).overShare).toBe(true);
  expect(reading(1, 0).overShare).toBe(true);
  // Output weighs eight times input: a little non-core output outweighs a lot of cached core input.
  expect(quotaSaverReading({ raw: undefined, now, zone: "America/Chicago", usage: [
    { purpose: NON_CORE_PURPOSE, inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000 },
    { purpose: "", inputTokens: 100_000, cachedInputTokens: 100_000, outputTokens: 0 }] }).overShare).toBe(true);
});

test("spendAllows: with the saver on, non-core work also needs a normal quota or the night, and room in its share; core never waits for it", () => {
  const spend = (over: Partial<BackgroundSpend> & { night?: boolean; overShare?: boolean; on?: boolean }): BackgroundSpend => ({
    mode: over.mode ?? "normal", engagement: "active",
    saver: { on: over.on ?? true, night: over.night ?? false, overShare: over.overShare ?? false, week: "2026-10-19" } });
  expect(spendAllows(spend({}), "discretionary", { nonCore: true })).toBe(true);
  expect(spendAllows(spend({ overShare: true }), "discretionary", { nonCore: true })).toBe(false);
  expect(saverStopsNonCore(spend({ overShare: true }), "discretionary")).toBe(true);
  // Core work (and non-core work asked without the flag) is not held by the saver.
  expect(spendAllows(spend({ overShare: true }), "core")).toBe(true);
  expect(spendAllows(spend({ overShare: true }), "discretionary")).toBe(true);
  // Line-skill compiling is core by its quota rule: in economy only at night while the saver is on, any time with it off.
  expect(spendAllows(spend({ mode: "economy" }), "core", { nonCore: true })).toBe(false);
  expect(spendAllows(spend({ mode: "economy", night: true }), "core", { nonCore: true })).toBe(true);
  expect(spendAllows(spend({ mode: "economy", on: false }), "core", { nonCore: true })).toBe(true);
  expect(spendAllows(spend({ overShare: true, on: false }), "discretionary", { nonCore: true })).toBe(true);
  // The night never lifts the kind's own rule: discretionary still needs a normal quota.
  expect(spendAllows(spend({ mode: "economy", night: true }), "discretionary", { nonCore: true })).toBe(false);
  // A quota that stops the kind anyway is not the saver's doing.
  expect(saverStopsNonCore(spend({ mode: "economy", overShare: true }), "discretionary")).toBe(false);
});

test("a batch review answers every candidate once", () => {
  expect(structuredOutputProblems(PUBLIC_SKILL_BATCH_REVIEW_SCHEMA)).toEqual([]);
  const ok = { reviews: [{ id: "s1", verdict: "usable", reasons: ["方法具体"] }, { id: "s2", verdict: "reject", reasons: ["内容空泛"] }] };
  expect(validatePublicSkillBatchReview(ok, ["s1", "s2"])).toEqual(ok);
  expect(() => validatePublicSkillBatchReview({ reviews: [ok.reviews[0]] }, ["s1", "s2"])).toThrow("SKILL_REVIEW_IDS_INVALID");
  expect(() => validatePublicSkillBatchReview({ reviews: [ok.reviews[0], ok.reviews[0]] }, ["s1"])).toThrow("SKILL_REVIEW_IDS_INVALID");
  expect(() => validatePublicSkillBatchReview({ reviews: [{ id: "s1", verdict: "maybe", reasons: ["x"] }] }, ["s1"])).toThrow("SKILL_REVIEW_SHAPE_INVALID");
});
