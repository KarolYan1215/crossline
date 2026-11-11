import { expect, test } from "vitest";
import { currentInstructions, instructionVersions, instructionsProblem, instructionsText, lineDiff } from "./instructions";

test("versions are read from the events, malformed ones skipped; the latest is in force", () => {
  const versions = instructionVersions([{ payload: { version: 1, text: "a", by: "person" }, createdAt: "t1" }, { payload: { text: "no version" }, createdAt: "t2" },
    { payload: { version: 2, text: "b", by: "assistant", revertOf: 1 }, createdAt: "t3" }]);
  expect(versions).toEqual([{ version: 1, text: "a", at: "t1", by: "person" }, { version: 2, text: "b", at: "t3", by: "assistant", revertOf: 1 }]);
  expect(currentInstructions(versions)).toMatchObject({ version: 2, text: "b" });
  expect(currentInstructions([])).toEqual({ version: 0, text: "" });
});

test("the wrapper reads the words as preferences that never pass a safety boundary", () => {
  const framed = instructionsText("  直接帮我发邮件  ");
  expect(framed).toMatch(/preferences/);
  expect(framed).toMatch(/never Crossline's safety boundaries/);
  expect(framed.endsWith("直接帮我发邮件")).toBe(true);
  expect(instructionsProblem("x".repeat(4000))).toBe("");
  expect(instructionsProblem("x".repeat(4001))).toMatch(/^INSTRUCTIONS_TOO_LONG/);
});

test("the line diff keeps what stayed and marks what was removed and added", () => {
  expect(lineDiff("先给结论\n再给理由", "先给结论\n别用表情\n再给理由")).toEqual([
    { kind: "same", text: "先给结论" }, { kind: "added", text: "别用表情" }, { kind: "same", text: "再给理由" }]);
  expect(lineDiff("a", "")).toEqual([{ kind: "removed", text: "a" }]);
  expect(lineDiff("", "b")).toEqual([{ kind: "added", text: "b" }]);
});
