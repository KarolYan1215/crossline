import { expect, test } from "vitest";
import { turnFailureAdvice } from "./skill-runner";

test("a provider's refusal is said in words the person can act on", () => {
  expect(turnFailureAdvice("Selected model is at capacity. Please try a different model.")).toMatch(/满载/);
  expect(turnFailureAdvice("429 Too Many Requests")).toMatch(/限流/);
  expect(turnFailureAdvice("This model's maximum context length is 128000 tokens")).toMatch(/长度/);
  expect(turnFailureAdvice(undefined)).toMatch(/技术信息/);
});
