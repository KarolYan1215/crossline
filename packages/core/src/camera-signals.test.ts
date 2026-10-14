import { expect, test } from "vitest";
import { blinkStats, cameraAggregate, eyeAspectRatio, LEFT_EYE, pulseEstimate } from "./camera-signals";

const fps = 15;

test("the eye aspect ratio is height over width: an open eye reads higher than a closed one", () => {
  const eye = (height: number) => {
    const points: Array<{ x: number; y: number }> = [];
    const [p1, p2, p3, p4, p5, p6] = LEFT_EYE;
    points[p1] = { x: 0, y: 0 }; points[p4] = { x: 30, y: 0 };
    points[p2] = { x: 10, y: -height }; points[p3] = { x: 20, y: -height };
    points[p6] = { x: 10, y: height }; points[p5] = { x: 20, y: height };
    return points;
  };
  expect(eyeAspectRatio(eye(5), LEFT_EYE)!).toBeCloseTo(1 / 3, 2);
  expect(eyeAspectRatio(eye(1), LEFT_EYE)!).toBeLessThan(0.1);
  expect(eyeAspectRatio([], LEFT_EYE)).toBeUndefined();
});

test("blinks are short closed runs, PERCLOS counts every closed frame, and a long closure is not a blink", () => {
  // 20 s: open at 0.3, with six 3-frame blinks and one 2-second closure.
  const series: number[] = Array.from({ length: 20 * fps }, () => 0.3);
  for (const start of [20, 60, 100, 140, 180, 220]) for (let i = 0; i < 3; i += 1) series[start + i] = 0.05;
  for (let i = 250; i < 280; i += 1) series[i] = 0.05;
  const stats = blinkStats(series, fps)!;
  expect(stats.blinkRate).toBe(18);
  expect(stats.perclos).toBeCloseTo(48 / 300, 3);
});

test("a clean 72-a-minute pulse in the forehead's green is found with high quality; noise is low quality", () => {
  const pulse = Array.from({ length: 20 * fps }, (_, i) => 120 + 0.6 * Math.sin(2 * Math.PI * 1.2 * i / fps) + 0.02 * i);
  const clean = pulseEstimate(pulse, fps)!;
  expect(Math.abs(clean.heartRate - 72)).toBeLessThanOrEqual(2);
  expect(clean.quality).toBeGreaterThan(0.5);
  let seed = 7;
  const noise = Array.from({ length: 20 * fps }, () => { seed = (seed * 16807) % 2147483647; return 120 + (seed / 2147483647 - 0.5) * 4; });
  expect(pulseEstimate(noise, fps)!.quality).toBeLessThan(clean.quality);
});

test("a window where the face was mostly missing gives no aggregate at all", () => {
  const ears = Array.from({ length: 20 * fps }, (_, i) => i % 3 === 0 ? 0.3 : undefined);
  expect(cameraAggregate(ears, Array.from({ length: 20 * fps }, () => 120), fps)).toBeUndefined();
});
