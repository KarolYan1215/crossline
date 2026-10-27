import { expect, test } from "vitest";
import { RATE, signal } from "./testing/audio";
import { originalTime, speechPieces, speechSegments } from "./vad";

test("silence and room noise hold no speech", () => {
  expect(speechSegments(new Float32Array(30 * RATE))).toEqual([]);
  expect(speechSegments(signal(30, []))).toEqual([]);
});

test("speech is found with a little padding, near stretches are joined, far ones kept apart", () => {
  const segments = speechSegments(signal(120, [[20, 30], [30.5, 35], [80, 82]]));
  expect(segments).toHaveLength(2);
  expect(segments[0]!.start / RATE).toBeGreaterThan(19.5);
  expect(segments[0]!.start / RATE).toBeLessThan(20);
  expect(segments[0]!.end / RATE).toBeGreaterThan(35);
  expect(segments[0]!.end / RATE).toBeLessThan(36);
  expect(segments[1]!.start / RATE).toBeGreaterThan(79.5);
});

test("a click shorter than a syllable is not speech", () => {
  expect(speechSegments(signal(30, [[10, 10.1]]))).toEqual([]);
});

test("speech is packed into pieces whose times map back into the recording", () => {
  const samples = signal(120, [[20, 30], [80, 82]]);
  const pieces = speechPieces(samples, speechSegments(samples));
  expect(pieces).toHaveLength(1);
  const piece = pieces[0]!;
  // About 13 seconds of speech and padding instead of two minutes.
  expect(piece.samples.length / RATE).toBeLessThan(16);
  expect(originalTime(piece.map, 1)).toBeCloseTo(piece.map[0]!.from + 1, 5);
  const second = piece.map[1]!;
  expect(originalTime(piece.map, second.at + 0.5)).toBeCloseTo(second.from + 0.5, 5);
  // A piece is never longer than asked; a long segment is cut.
  const long = speechPieces(samples, [{ start: 0, end: 100 * RATE }], RATE, 30);
  expect(long.map((item) => Math.round(item.samples.length / RATE))).toEqual([30, 30, 30, 10]);
  expect(originalTime(long[1]!.map, 5)).toBe(35);
});
