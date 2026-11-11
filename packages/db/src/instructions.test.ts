import { expect, test } from "vitest";
import { CrosslineStore } from "./index";
import { currentInstructionsOf, instructionVersionsOf, setInstructions } from "./personal-design";

test("「给 Crossline 的话」: every version is a ledger event, an unchanged text writes nothing, a revert is a new version", () => {
  const store = new CrosslineStore(":memory:");
  const base = { workspaceId: "w", ownerId: "p" };
  expect(currentInstructionsOf(store, "w")).toEqual({ version: 0, text: "" });
  expect(setInstructions(store, { ...base, text: "先给结论\r\n再给理由 ", by: "person" })).toEqual({ version: 1, text: "先给结论\n再给理由", changed: true });
  expect(setInstructions(store, { ...base, text: "先给结论\n再给理由", by: "assistant" }).changed).toBe(false);
  setInstructions(store, { ...base, text: "先给结论", by: "assistant" });
  setInstructions(store, { ...base, text: "先给结论\n再给理由", by: "person", revertOf: 1 });
  expect(instructionVersionsOf(store, "w").map((item) => [item.version, item.by, item.revertOf ?? null])).toEqual([[1, "person", null], [2, "assistant", null], [3, "person", 1]]);
  expect(store.listEvents("w", { type: "instructions.set" })).toHaveLength(3);
  expect(() => setInstructions(store, { ...base, text: "字".repeat(4001), by: "person" })).toThrow("INSTRUCTIONS_TOO_LONG");
  expect(currentInstructionsOf(store, "other").version).toBe(0);
  store.close();
});
