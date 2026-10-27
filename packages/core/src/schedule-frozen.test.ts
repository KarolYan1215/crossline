import { describe, expect, test } from "vitest";
import { parseFrozen, settleFrozen, shiftFrozen, withFrozen, withoutFrozen, type FrozenBlock } from "./schedule-frozen";

const now = new Date("2026-10-12T15:00:00.000Z");
const block = (blockId: string, extra: Partial<FrozenBlock> = {}): FrozenBlock =>
  ({ blockId, start: "2026-10-12T16:00:00.000Z", end: "2026-10-12T17:00:00.000Z", reason: "locked", ...extra });

describe("schedule.frozen", () => {
  test("drops what has ended and what has expired, keeps the rest", () => {
    const raw = JSON.stringify([block("keep"), block("ended", { start: "2026-10-12T10:00:00.000Z", end: "2026-10-12T11:00:00.000Z" }),
      block("expired", { reason: "keep", until: "2026-10-12T14:00:00.000Z" }), block("still", { reason: "keep", until: "2026-10-19T00:00:00.000Z" })]);
    expect(parseFrozen(raw, now).map((item) => item.blockId)).toEqual(["keep", "still"]);
  });

  test("a commit hold outlives its block's end until its grace runs out", () => {
    const raw = JSON.stringify([block("grace", { reason: "commit", start: "2026-10-12T13:30:00.000Z", end: "2026-10-12T14:30:00.000Z", until: "2026-10-12T15:30:00.000Z" }),
      block("lapsed", { reason: "commit", start: "2026-10-12T12:00:00.000Z", end: "2026-10-12T13:00:00.000Z", until: "2026-10-12T14:00:00.000Z" })]);
    expect(parseFrozen(raw, now).map((item) => item.blockId)).toEqual(["grace"]);
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

describe("settleFrozen: overlap is allowed, conflict is asked about", () => {
  const at = (hour: number) => Date.parse(`2026-10-16T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const entry = (blockId: string, reason: FrozenBlock["reason"], from: number, to: number, extra: Partial<FrozenBlock> = {}): FrozenBlock =>
    ({ blockId, reason, start: new Date(at(from)).toISOString(), end: new Date(at(to)).toISOString(), ...extra });
  const meeting = { id: "graph_calendar:m", start: at(14), end: at(15) };

  test("a kept or committed block a meeting lands on is let go; a locked one stays and is a conflict", () => {
    const { kept, released, conflicts } = settleFrozen([entry("keep", "keep", 14, 15), entry("commit", "commit", 14, 15), entry("locked", "locked", 14, 15)], [meeting]);
    expect(kept.map((item) => item.blockId)).toEqual(["locked"]);
    expect(released.map((item) => item.blockId).sort()).toEqual(["commit", "keep"]);
    expect(conflicts).toEqual([{ blockId: "locked", with: "graph_calendar:m", kind: "busy" }]);
  });

  test("an overlap the person accepted is kept and no longer a conflict", () => {
    const { kept, conflicts } = settleFrozen([entry("locked", "locked", 14, 15, { overlapOk: true })], [meeting]);
    expect(kept).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  test("frozen blocks on each other: a kept one gives way to a held one; two held ones are a conflict for the person", () => {
    const settled = settleFrozen([entry("kept", "keep", 10, 11), entry("pinned", "pinned", 10, 11), entry("locked", "locked", 10, 12), entry("later", "commit", 12, 13)], []);
    expect(settled.kept.map((item) => item.blockId)).toEqual(["pinned", "locked", "later"]);
    expect(settled.released.map((item) => item.blockId)).toEqual(["kept"]);
    expect(settled.conflicts).toEqual([{ blockId: "locked", with: "pinned", kind: "frozen" }]);
  });

  test("a lock older than the task's deferral lapses; a block the person started does not", () => {
    const deferred = (blockId: string) => blockId.startsWith("scheduled:a") ? at(20) : undefined;
    const { kept, released } = settleFrozen([entry("scheduled:a:v1s1", "locked", 9, 10), entry("scheduled:a:v1s2", "pinned", 10, 11),
      entry("scheduled:b:v1s1", "locked", 9, 10)], [], deferred);
    expect(released.map((item) => item.blockId)).toEqual(["scheduled:a:v1s1"]);
    expect(kept.map((item) => item.blockId)).toEqual(["scheduled:a:v1s2", "scheduled:b:v1s1"]);
  });
});
