import { expect, test } from "vitest";
import { classifyReplay } from "./replay";

test("a permanently rejected command stops being retried instead of looping invisibly", () => {
  // These are the server saying the command will never be accepted as written.
  for (const status of [400, 403, 404, 422]) expect(classifyReplay(status)).toBe("dead_letter");
});

test("the two 4xx that really mean try again are retried", () => {
  expect(classifyReplay(408)).toBe("retry");
  expect(classifyReplay(429)).toBe("retry");
});

test("409 is its own outcome, not a dead letter: the command was fine, the object moved on", () => {
  expect(classifyReplay(409)).toBe("conflict");
});

test("a request that never reached the server is retried, not buried", () => {
  expect(classifyReplay(undefined)).toBe("retry");
  for (const status of [500, 502, 503]) expect(classifyReplay(status)).toBe("retry");
});

test("success clears the command", () => {
  for (const status of [200, 201, 204]) expect(classifyReplay(status)).toBe("done");
});
