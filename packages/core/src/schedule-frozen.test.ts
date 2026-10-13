import { describe, expect, test } from "vitest";
import { parseFrozen, withFrozen, withoutFrozen, type FrozenBlock } from "./schedule-frozen";

const now = new Date("2026-10-12T15:00:00.000Z");
const block = (blockId: string, extra: Partial<FrozenBlock> = {}): FrozenBlock =>
  ({ blockId, start: "2026-10-12T16:00:00.000Z", end: "2026-10-12T17:00:00.000Z", reason: "locked", ...extra });

describe("schedule.frozen", () => {
  test("drops what has ended and what has expired, keeps the rest", () => {
    const raw = JSON.stringify([block("keep"), block("ended", { start: "2026-10-12T10:00:00.000Z", end: "2026-10-12T11:00:00.000Z" }),
      block("expired", { reason: "keep", until: "2026-10-12T14:00:00.000Z" }), block("still", { reason: "keep", until: "2026-10-19T00:00:00.000Z" })]);
    expect(parseFrozen(raw, now).map((item) => item.blockId)).toEqual(["keep", "still"]);
  });

  test("a bad or empty value reads as nothing frozen", () => {
    expect(parseFrozen("not json", now)).toEqual([]);
    expect(parseFrozen(undefined, now)).toEqual([]);
    expect(parseFrozen(JSON.stringify({ blockId: "x" }), now)).toEqual([]);
    expect(parseFrozen(JSON.stringify([{ blockId: "x" }]), now)).toEqual([]);
  });

  test("the same block id is replaced, not doubled, and can be removed", () => {
    const list = withFrozen([block("a"), block("b")], block("a", { reason: "pinned", start: "2026-10-12T18:00:00.000Z", end: "2026-10-12T19:00:00.000Z" }));
    expect(list.map((item) => [item.blockId, item.reason])).toEqual([["b", "locked"], ["a", "pinned"]]);
    expect(withoutFrozen(list, "a").map((item) => item.blockId)).toEqual(["b"]);
  });
});
