import { expect, test } from "vitest";
import { createUsageCollector } from "./usage";

const reading = (input: number, cached: number, output: number) =>
  ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });
const note = (turnId: string, last: ReturnType<typeof reading>, total?: ReturnType<typeof reading>) =>
  ({ threadId: "t", turnId, tokenUsage: { last, ...(total ? { total } : {}), modelContextWindow: null } });

// The owner's interview on 2026-11-28: an extraction run that looked a sentence up made two requests, and only the second was billed.
test("a turn that calls a tool is billed for every request it made, not its last", () => {
  const usage = createUsageCollector();
  usage.note(note("turn-1", reading(64_489, 13_952, 300), reading(64_489, 13_952, 300)));
  usage.note(note("turn-1", reading(65_374, 64_384, 28), reading(129_863, 78_336, 328)));
  expect(usage.total()).toMatchObject({ inputTokens: 129_863, cachedInputTokens: 78_336, outputTokens: 328 });
});

test("a resumed thread's earlier turns are not counted again, and a repeated reading changes nothing", () => {
  const usage = createUsageCollector();
  // The thread had used 500k before this run; the run's one turn makes two requests, the second reported twice.
  usage.note(note("turn-9", reading(110_000, 108_000, 400), reading(610_000, 590_000, 2_400)));
  usage.note(note("turn-9", reading(112_000, 111_000, 50), reading(722_000, 701_000, 2_450)));
  usage.note(note("turn-9", reading(112_000, 111_000, 50), reading(722_000, 701_000, 2_450)));
  expect(usage.total()).toMatchObject({ inputTokens: 222_000, cachedInputTokens: 219_000, outputTokens: 450 });
  expect(usage.turns()).toBe(1);
});

test("without a running sum the latest request of each turn is what is known, summed over turns", () => {
  const usage = createUsageCollector();
  usage.note(note("turn-1", reading(1_000, 0, 10)));
  usage.note(note("turn-2", reading(2_000, 1_000, 20)));
  expect(usage.total()).toMatchObject({ inputTokens: 3_000, cachedInputTokens: 1_000, outputTokens: 30 });
});
