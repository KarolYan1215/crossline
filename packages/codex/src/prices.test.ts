import { expect, test } from "vitest";
import { spentFor } from "./prices";

test("a month's spend is tokens at the rate, output and reasoning at the output rate, and the rate can be set", () => {
  const usage = [{ inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: 100_000 }];
  expect(spentFor(usage, {})).toBeCloseTo(10 + 8);
  expect(spentFor(usage, { CROSSLINE_API_PRICE_PER_MTOK: "1.25:10" })).toBeCloseTo(1.25 + 2);
  expect(spentFor(usage, { CROSSLINE_API_PRICE_PER_MTOK: "nonsense" })).toBeCloseTo(18);
});
