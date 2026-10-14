/**
 * The camera's contribution to the energy model, as numbers only (docs/energy-and-ecosystem.md §8, decided 2026-10-14: desktop only, off
 * unless turned on, frames never leave the page). The page reads face landmarks and the forehead's average colour from each frame of a
 * twenty-second window; these functions turn those series into four aggregates — blinks a minute, the share of time the eyes were
 * closed (PERCLOS), a pulse estimate and how clean that estimate is. Webcam pulse is fair for the rate and poor for its variability, so
 * no heart-rate variability is computed. Each aggregate is only ever a covariate the backtest must admit (`energy-covariates.ts`).
 */

export type Point = { x: number; y: number };
/** 摄像头精力采样, its own consent (desktop only, off unless turned on). */
export const CAMERA_ENERGY_CONSENT = "energy.camera";
/** The only numbers a camera window may send, each with the range a real reading falls in. */
export const CAMERA_AGGREGATE_RANGES: Record<keyof CameraAggregate, [number, number]> = {
  blinkRate: [0, 120], perclos: [0, 1], heartRate: [0, 220], quality: [0, 1], windowSeconds: [5, 120]
};
export type CameraAggregate = { blinkRate: number; perclos: number; heartRate: number; quality: number; windowSeconds: number };

/** MediaPipe face-mesh indices of the six eye points (outer corner, two upper, inner corner, two lower), per eye. */
export const LEFT_EYE = [33, 160, 158, 133, 153, 144] as const;
export const RIGHT_EYE = [362, 385, 387, 263, 373, 380] as const;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Eye aspect ratio (Soukupová & Čech 2016): the eye's height over its width, near 0.3 open and falling towards 0 closed. */
export function eyeAspectRatio(points: Point[], eye: readonly number[]): number | undefined {
  const [p1, p2, p3, p4, p5, p6] = eye.map((index) => points[index]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return undefined;
  const width = distance(p1, p4);
  return width > 0 ? (distance(p2, p6) + distance(p3, p5)) / (2 * width) : undefined;
}

/**
 * Blinks and closure from a series of eye aspect ratios (undefined where no face was found). "Closed" is relative to the person's own
 * open eye in this window — under 60% of the window's 80th-percentile ratio — so glasses and camera angle do not move the line. A blink
 * is a closed run of at most 0.5 s; PERCLOS counts all closed frames.
 */
export function blinkStats(series: Array<number | undefined>, fps: number): { blinkRate: number; perclos: number; seen: number } | undefined {
  const values = series.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (values.length < fps * 5) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const open = sorted[Math.floor(sorted.length * 0.8)]!;
  const line = open * 0.6;
  let blinks = 0, closed = 0, run = 0;
  for (const value of series) {
    if (value === undefined) { run = 0; continue; }
    if (value < line) { closed += 1; run += 1; continue; }
    if (run > 0 && run <= fps * 0.5) blinks += 1;
    run = 0;
  }
  const seconds = values.length / fps;
  return { blinkRate: Math.round(blinks / seconds * 60 * 10) / 10, perclos: Math.round(closed / values.length * 1000) / 1000, seen: values.length / series.length };
}

/**
 * A pulse estimate from the forehead's average green over time (remote photoplethysmography): detrended by a one-second moving average,
 * then the strongest frequency between 42 and 180 beats a minute by a discrete Fourier scan. `quality` is that peak's share of the
 * band's power — near 1 for a clean pulse, low for movement and lighting changes.
 */
export function pulseEstimate(green: number[], fps: number): { heartRate: number; quality: number } | undefined {
  if (green.length < fps * 10) return undefined;
  const window = Math.max(1, Math.round(fps));
  const detrended = green.map((value, index) => {
    const from = Math.max(0, index - window), to = Math.min(green.length, index + window + 1);
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += green[i]!;
    return value - sum / (to - from);
  });
  let best = 0, bestPower = 0, total = 0;
  for (let bpm = 42; bpm <= 180; bpm += 1) {
    const hz = bpm / 60;
    let re = 0, im = 0;
    detrended.forEach((value, index) => { const angle = 2 * Math.PI * hz * index / fps; re += value * Math.cos(angle); im -= value * Math.sin(angle); });
    const power = re * re + im * im;
    total += power;
    if (power > bestPower) { bestPower = power; best = bpm; }
  }
  // The peak and its two neighbours, against everything in the band.
  return total > 0 ? { heartRate: best, quality: Math.round(Math.min(1, bestPower * 3 / total) * 100) / 100 } : undefined;
}

/** One window's aggregate, or undefined when the face was seen too little for any of it to mean something. */
export function cameraAggregate(ears: Array<number | undefined>, green: number[], fps: number): CameraAggregate | undefined {
  const blinks = blinkStats(ears, fps);
  if (!blinks || blinks.seen < 0.6) return undefined;
  const pulse = pulseEstimate(green, fps);
  return { blinkRate: blinks.blinkRate, perclos: blinks.perclos, heartRate: pulse?.heartRate ?? 0, quality: pulse?.quality ?? 0,
    windowSeconds: Math.round(ears.length / fps) };
}
