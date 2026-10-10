import { expect, test } from "vitest";
import { DEFAULT_CALIBRATION, calibrate, mergeSleep, phaseShiftFromPeak, predictEnergy, sleepFromGaps } from "./index";

// Chicago in October is UTC−5.
const hour = (iso: string) => (new Date(iso).getUTCHours() + 24 - 5) % 24 + new Date(iso).getUTCMinutes() / 60;

test("a long idle stretch over the night is sleep; a long afternoon away is not", () => {
  const gaps = [{ from: "2026-10-10T05:30:00Z", to: "2026-10-10T12:30:00Z" }, { from: "2026-10-10T18:00:00Z", to: "2026-10-10T23:00:00Z" }];
  expect(sleepFromGaps(gaps, hour)).toEqual([{ sleepAt: "2026-10-10T05:30:00Z", wakeAt: "2026-10-10T12:30:00Z", source: "screen" }]);
});

test("the phone's record of a night wins over the screen's guess for it", () => {
  const screen = [{ sleepAt: "2026-10-10T04:00:00Z", wakeAt: "2026-10-10T13:00:00Z", source: "screen" }];
  const phone = [{ sleepAt: "2026-10-10T05:10:00Z", wakeAt: "2026-10-10T12:20:00Z", source: "ios-health" }];
  expect(mergeSleep(screen, phone)).toEqual(phone);
});

test("a rested morning reads high for a morning person and a short night's late evening low; with no sleep known it is unknown", () => {
  const shift = phaseShiftFromPeak(9, 12);
  const night = [{ sleepAt: "2026-10-10T04:00:00Z", wakeAt: "2026-10-10T12:00:00Z", source: "screen" }]; // 23:00–07:00
  expect(predictEnergy("2026-10-10T15:00:00Z", night, DEFAULT_CALIBRATION, hour, shift).level).toBe("high"); // 10:00
  const short = [{ sleepAt: "2026-10-10T07:00:00Z", wakeAt: "2026-10-10T12:00:00Z", source: "screen" }]; // 02:00–07:00
  expect(predictEnergy("2026-10-11T03:00:00Z", short, DEFAULT_CALIBRATION, hour, shift).level).toBe("low"); // 22:00
  expect(predictEnergy("2026-10-12T15:00:00Z", night, DEFAULT_CALIBRATION, hour, shift)).toMatchObject({ confidence: "low", basis: ["不知道最近一次睡眠"] });
});

test("the person's reports move the cut points and earn confidence; a few reports are pulled towards the default", () => {
  const one = calibrate([{ alertness: 13, level: "medium" }]);
  expect(one.reports).toBe(1);
  expect(Math.abs(one.high - DEFAULT_CALIBRATION.high)).toBeLessThan(1);
  // This person calls 11 high and 8 low, again and again.
  const many = calibrate(Array.from({ length: 10 }, (_, index) => index % 2 ? { alertness: 11, level: "high" as const } : { alertness: 8, level: "low" as const }));
  expect(many.high).toBeLessThanOrEqual(11);
  expect(many.low).toBeGreaterThan(8);
  expect(many.agreement).toBe(1);
  const night = [{ sleepAt: "2026-10-10T04:00:00Z", wakeAt: "2026-10-10T12:00:00Z", source: "screen" }];
  expect(predictEnergy("2026-10-10T15:00:00Z", night, many, hour).confidence).toBe("high");
});
