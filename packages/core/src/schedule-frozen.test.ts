import { describe, expect, test } from "vitest";
import { parseFrozen, shiftFrozen, withFrozen, withoutFrozen, type FrozenBlock } from "./schedule-frozen";

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

test("「后面都推 10 分钟」 moves today's committed and kept blocks, never what the person started or locked, nor tomorrow's", () => {
  const now = new Date("2026-10-14T15:05:00.000Z");
  const dayEnd = new Date("2026-10-15T05:00:00.000Z");
  const block = (blockId: string, reason: FrozenBlock["reason"], start: string, end: string) => ({ blockId, reason, start: `2026-10-${start}:00.000Z`, end: `2026-10-${end}:00.000Z` });
  const shifted = shiftFrozen([
    block("scheduled:a", "commit", "14T15:00", "14T16:00"),   // under way: starts ten minutes from now, ends ten minutes later
    block("scheduled:b", "keep", "14T16:00", "14T17:00"),
    block("scheduled:c", "pinned", "14T17:00", "14T18:00"),
    block("scheduled:d", "locked", "14T18:00", "14T19:00"),
    block("scheduled:e", "keep", "15T15:00", "15T16:00"),
    block("scheduled:f", "keep", "14T13:00", "14T14:00")
  ], 10, now, dayEnd);
  expect(shifted.map((item) => [item.blockId, item.start.slice(11, 16), item.end.slice(11, 16)])).toEqual([
    ["scheduled:a", "15:15", "16:10"], ["scheduled:b", "16:10", "17:10"], ["scheduled:c", "17:00", "18:00"], ["scheduled:d", "18:00", "19:00"],
    ["scheduled:e", "15:00", "16:00"], ["scheduled:f", "13:00", "14:00"]]);
  expect(shifted[0]!.until).toBe("2026-10-14T16:10:00.000Z");
});
