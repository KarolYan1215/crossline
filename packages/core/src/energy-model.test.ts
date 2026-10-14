import { expect, test } from "vitest";
import { DEFAULT_CALIBRATION, alertnessAt, calibrate, dayCapacity, homeostat, inertia, mergeSleep, phaseShiftFromPeak, predictEnergy, sleepDebt, sleepFromGaps } from "./index";

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

// Nights 23:00–07:00 Chicago (04:00–12:00Z), or shorter, for `count` nights ending on the morning of 2026-10-10 + count − 1.
const nights = (count: number, hours: number, source = "ios-health") => Array.from({ length: count }, (_, index) => {
  const wake = Date.parse("2026-10-01T12:00:00Z") + index * 86_400_000;
  return { sleepAt: new Date(wake - hours * 3_600_000).toISOString(), wakeAt: new Date(wake).toISOString(), source };
});

test("short nights add up: five nights of five hours leave the sixth morning lower than one short night after rested ones", () => {
  const chronic = nights(6, 5);
  const oneShort = [...nights(5, 8), ...nights(6, 5).slice(5)];
  const at = "2026-10-06T15:00:00Z"; // 10:00 on the sixth morning
  expect(alertnessAt(at, chronic, hour)!).toBeLessThan(alertnessAt(at, oneShort, hour)! - 1);
  expect(sleepDebt(at, chronic).hours).toBeGreaterThan(15);
});

test("sleep inertia lowers the first hour after waking and is gone by the third", () => {
  expect(inertia(0.5)).toBeLessThan(inertia(2));
  expect(Math.abs(inertia(3))).toBeLessThan(1);
  const rested = nights(7, 8);
  const just = alertnessAt("2026-10-07T12:20:00Z", rested, hour)!, later = alertnessAt("2026-10-07T14:00:00Z", rested, hour)!;
  expect(just).toBeLessThan(later);
});

test("a stretch with no record is taken as usual nights, not as days awake, and is counted", () => {
  const gap = [...nights(2, 8), ...nights(8, 8).slice(6)]; // nights 1–2, then 7–8: four nights missing
  const full = nights(8, 8);
  const at = "2026-10-08T15:00:00Z";
  expect(homeostat(at, gap).assumedNights).toBeGreaterThanOrEqual(3);
  expect(Math.abs(homeostat(at, gap).s - homeostat(at, full).s)).toBeLessThan(0.5);
});

test("capacity only lowers the day: debt, low heart-rate variability and a warm wrist each cost a little, never below 70%", () => {
  const at = "2026-10-08T15:00:00Z", day = "2026-10-08";
  expect(dayCapacity(at, day, nights(8, 8), []).multiplier).toBe(1);
  const baseline = ["01", "02", "03", "04", "05"].map((d) => ({ day: `2026-10-${d}`, hrvMs: 60 + Number(d), restingHr: 55 }));
  // Under four days of baseline the heart-rate reading is ignored.
  expect(dayCapacity(at, day, nights(8, 8), [...baseline.slice(0, 3), { day, hrvMs: 20 }]).multiplier).toBe(1);
  const tired = dayCapacity(at, day, nights(8, 5), [...baseline, { day, hrvMs: 30, restingHr: 70, wristTempDeltaC: 0.8 }]);
  expect(tired.multiplier).toBeLessThan(0.9);
  expect(tired.multiplier).toBeGreaterThanOrEqual(0.7);
  expect(tired.basis.join(" ")).toContain("手腕温度");
});

test("a phone's sleep record wins over the sleep-focus switch, which wins over the screen", () => {
  const screen = [{ sleepAt: "2026-10-10T04:00:00Z", wakeAt: "2026-10-10T13:00:00Z", source: "screen" }];
  const focus = [{ sleepAt: "2026-10-10T04:30:00Z", wakeAt: "2026-10-10T12:30:00Z", source: "phone-focus" }];
  expect(mergeSleep(screen, focus)).toEqual(focus);
  const phone = [{ sleepAt: "2026-10-10T05:10:00Z", wakeAt: "2026-10-10T12:20:00Z", source: "ios-health" }];
  expect(mergeSleep(phone, focus, screen)).toEqual(phone);
});
