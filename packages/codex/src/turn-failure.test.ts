import { expect, test } from "vitest";
import { skillErrorCode, turnFailureAdvice } from "./skill-runner";

test("a runtime gone under a pending request is the retryable runtime exit, whichever runtime it was", () => {
  for (const message of ["CROSSLINE_NODE_DISCONNECTED", "CODEX_APP_SERVER_EXITED", "CODEX_APP_SERVER_STOPPED"]) {
    expect(skillErrorCode(new Error(message))).toBe("SKILL_RUNTIME_EXITED");
  }
  expect(skillErrorCode(new Error("SKILL_STALLED"))).toBe("SKILL_STALLED");
  expect(skillErrorCode(new Error("thread not found: t"))).toBe("SKILL_THREAD_LOST");
  expect(skillErrorCode(new Error("boom"))).toBe("SKILL_RUNTIME_FAILED");
});

test("a provider's refusal is said in words the person can act on", () => {
  expect(turnFailureAdvice("Selected model is at capacity. Please try a different model.")).toMatch(/满载/);
  expect(turnFailureAdvice("429 Too Many Requests")).toMatch(/限流/);
  expect(turnFailureAdvice("This model's maximum context length is 128000 tokens")).toMatch(/长度/);
  expect(turnFailureAdvice(undefined)).toMatch(/技术信息/);
});
