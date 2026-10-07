import { describe, expect, test } from "vitest";
import { backtestResidual, calibratedEstimate, calibrationReport, fitCalibration, MIN_OBSERVATIONS_TO_PROMOTE, predictCalibrated,
  shouldPromote, type CalibrationObservation } from "./calibration";
import type { Estimate } from "./index";

const V = "crossline.analysis.v2";
/** Deterministic pseudo-noise: same sequence every run. */
function noise(seed: number) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31 - 0.5; }; }
function history(n: number, bias: number, spread: number, options: { family?: string; start?: string; version?: string } = {}): CalibrationObservation[] {
  const r = noise(n * 7 + Math.round(bias * 100));
  const start = Date.parse(options.start ?? "2026-08-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => {
    const llmP50 = 30 + ((i * 37) % 150);
    return { identityId: "research", family: options.family ?? "deep_work", llmP50, llmP85: Math.round(llmP50 * 1.6),
      actualMinutes: Math.max(1, Math.round(llmP50 * bias * Math.exp(spread * r()))), observedAt: new Date(start + i * 86_400_000).toISOString(),
      contextVersion: options.version ?? V, censored: false };
  });
}
const now = new Date("2026-10-06T00:00:00Z");
const llmEstimate = (p50: number, p85: number): Estimate => ({ p25Minutes: Math.round(p50 * 0.7), p50Minutes: p50, p85Minutes: p85, source: "llm_prior", observationCount: 0, confidence: "low" });

describe("residual calibration", () => {
  test("finds a real ×1.4 underestimate and corrects toward it", () => {
    const model = fitCalibration(history(40, 1.4, 0.2), now, V);
    expect(Math.exp(model.mu + model.buckets["research/deep_work"]!.delta)).toBeGreaterThan(1.25);
    expect(Math.exp(model.mu + model.buckets["research/deep_work"]!.delta)).toBeLessThan(1.5);
    const report = calibrationReport(history(40, 1.4, 0.2), now, V);
    expect(report.promoted).toBe(true);
    const corrected = calibratedEstimate(llmEstimate(100, 160), report, "research", "deep_work");
    expect(corrected.p50Minutes).toBeGreaterThan(125);
    expect(corrected.calibration).toMatchObject({ state: "applied", raw: { p50Minutes: 100, p85Minutes: 160 } });
  });

  test("an unbiased model with noisy actuals is not 'corrected' — it stays learning", () => {
    const report = calibrationReport(history(30, 1.0, 0.5), now, V);
    expect(report.promoted).toBe(false);
    const result = calibratedEstimate(llmEstimate(100, 160), report, "research", "deep_work");
    expect(result.p50Minutes).toBe(100);
    expect(result.calibration).toMatchObject({ state: "learning" });
  });

  test("too few completions never promote, and say how many more are needed", () => {
    const report = calibrationReport(history(4, 1.6, 0.05), now, V);
    expect(report.promoted).toBe(false);
    expect(calibratedEstimate(llmEstimate(60, 90), report, "research", "deep_work").calibration).toMatchObject({ needed: MIN_OBSERVATIONS_TO_PROMOTE - 4 });
  });

  test("with enough residuals the p85 is their empirical 85th percentile, which covers about 85% in a backtest", () => {
    const data = history(80, 1.2, 0.4);
    const backtest = backtestResidual(data, V);
    expect(backtest.coverageCalibrated!).toBeGreaterThan(0.7);
    expect(backtest.coverageCalibrated!).toBeLessThan(0.97);
    expect(fitCalibration(data, now, V).residualQ85).not.toBeNull();
  });

  test("censored rows are counted but never fitted", () => {
    const data = history(10, 1.0, 0.1);
    const withCensored = [...data, { ...data[0]!, actualMinutes: 1000, censored: true }];
    expect(fitCalibration(withCensored, now, V).censored).toBe(1);
    expect(fitCalibration(withCensored, now, V).mu).toBeCloseTo(fitCalibration(data, now, V).mu, 6);
  });

  test("observations from another analysis version count half, and old ones fade", () => {
    const old = history(20, 2.0, 0.05, { version: "crossline.analysis.v1" });
    const fresh = history(20, 1.0, 0.05, { start: "2026-09-10T00:00:00Z" });
    const mu = fitCalibration([...old, ...fresh], now, V).mu;
    expect(Math.exp(mu)).toBeLessThan(1.35);
  });

  test("a buckets' own bias is shrunk toward the person's overall bias when it has few points", () => {
    const many = history(30, 1.3, 0.1);
    const few = history(2, 3.0, 0.1, { family: "review" });
    const model = fitCalibration([...many, ...few], now, V);
    const reviewFactor = Math.exp(model.mu + model.buckets["research/review"]!.delta);
    expect(reviewFactor).toBeLessThan(2.2);
    expect(reviewFactor).toBeGreaterThan(1.3);
  });

  test("a person's own number is never corrected", () => {
    const report = calibrationReport(history(40, 1.4, 0.2), now, V);
    const manual: Estimate = { ...llmEstimate(100, 160), source: "manual" };
    expect(calibratedEstimate(manual, report, "research", "deep_work")).toEqual(manual);
    expect(shouldPromote({ evaluated: 2, maeRaw: 1, maeCalibrated: 0.1, coverageRaw: 0.5, coverageCalibrated: 0.85 })).toBe(false);
    expect(predictCalibrated(report.model, { p50Minutes: 50, p85Minutes: 80 }, "research", undefined).p50Minutes).toBeGreaterThan(50);
  });
});
