import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { FROZEN_RACE_REPAIR, IMPORT_DUPLICATE_REPAIR, repairDuplicateImports, repairFrozenRace } from "./calendar-repair";

let store: CrosslineStore;
let ws: string;
let owner: string;
beforeEach(() => { store = new CrosslineStore(":memory:"); const made = store.createPrincipalWithWorkspace("u", "w"); ws = made.workspace.id; owner = made.principal.id; });
afterEach(() => store.close());

const entry = (blockId: string, reason: string, extra: Record<string, unknown> = {}) =>
  ({ blockId, reason, start: "2099-01-01T14:00:00.000Z", end: "2099-01-01T15:00:00.000Z", ...extra });
const published = () => store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `calendar:published:${Math.random()}`, type: "calendar.published",
  entityId: "xl", payload: { created: 1 } });

test("releases locks the calendar read-back took for the person's, clears 「deleted by the person」, once, with an event and an undo", () => {
  published();
  const before = [entry("scheduled:a:v1s1", "locked"), entry("scheduled:b", "pinned"), entry("scheduled:c", "keep", { until: "2099-01-02T00:00:00.000Z" }),
    entry("scheduled:d", "commit"), entry("scheduled:e", "locked", { via: "calendar" })];
  store.setSetting(ws, "schedule.frozen", JSON.stringify(before));
  store.setSetting(ws, "calendar.published", JSON.stringify({ "scheduled:x": { eventId: "1", title: "t", start: "s", end: "e", removedByPerson: true },
    "scheduled:y": { eventId: "2", title: "t", start: "s", end: "e" } }));
  const result = repairFrozenRace(store, ws, owner, new Date("2026-10-15T09:00:00Z"));
  expect(result).toEqual({ released: ["scheduled:a:v1s1"], republished: ["scheduled:x"] });
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!).map((item: { blockId: string }) => item.blockId))
    .toEqual(["scheduled:b", "scheduled:c", "scheduled:d", "scheduled:e"]);
  expect(Object.keys(JSON.parse(store.getSetting(ws, "calendar.published")!))).toEqual(["scheduled:y"]);
  expect(store.listEvents(ws, { type: "repair.frozen_race" })[0]!.payload).toMatchObject({ released: [{ blockId: "scheduled:a:v1s1" }], republished: ["scheduled:x"] });
  const op = store.listEvents(ws, { type: "op.applied" })[0]!.payload as { inverse: { kind: string; entries: Array<{ key: string; value: string }> } };
  expect(op.inverse).toEqual({ kind: "settings.restore", entries: [{ key: "schedule.frozen", value: JSON.stringify(before) }] });
  expect(store.getSetting(ws, FROZEN_RACE_REPAIR)).toBe("2026-10-15T09:00:00.000Z");
  // Once only: a lock taken later is left alone.
  store.setSetting(ws, "schedule.frozen", JSON.stringify([entry("scheduled:f", "locked")]));
  expect(repairFrozenRace(store, ws, owner)).toBeUndefined();
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!)).toHaveLength(1);
});

test("a lock the person may have made through an undoable operation is kept; nothing happens where nothing was ever published", () => {
  store.setSetting(ws, "schedule.frozen", JSON.stringify([entry("scheduled:a", "locked")]));
  expect(repairFrozenRace(store, ws, owner)).toEqual({ released: [], republished: [] });
  expect(JSON.parse(store.getSetting(ws, "schedule.frozen")!)).toHaveLength(1);

  store.deleteSetting(ws, FROZEN_RACE_REPAIR);
  published();
  store.setSetting(ws, "schedule.frozen", JSON.stringify([entry("scheduled:a", "locked"), entry("scheduled:b", "locked")]));
  // The lock button's undo: before it, only `a` was locked — so `b` may be the person's.
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: "op.applied:op-1", type: "op.applied", entityId: "op-1",
    payload: { label: "锁定时间块", inverse: { kind: "settings.restore", entries: [{ key: "schedule.frozen", value: JSON.stringify([entry("scheduled:a", "locked")]) }] } } });
  expect(repairFrozenRace(store, ws, owner)).toEqual({ released: ["scheduled:a"], republished: [] });
});

test("an imported weekly class and that day's dated session in one slot keep the dated block, once, with the removed block on record", () => {
  const block = (id: string, day: string, title: string) => ({ id, lane: "human", title, day, start: "14:30", end: "15:45", source: "文件导入", readOnly: true });
  const blocks = [block("graph_calendar:x", "2026-12-07", "日历里的同一时段"), block("import:b1:class:2026-12-07", "2026-12-07", "ECE 555 上课"),
    block("import:b1:final-2026-12-07", "2026-12-07", "课堂期末考试"), block("import:b1:class:2026-12-04", "2026-12-04", "ECE 555 上课")];
  store.savePlanVersion({ id: "plan-1", ownerId: owner, workspaceId: ws, version: 1, status: "current", payload: { blocks } });
  expect(repairDuplicateImports(store, ws, owner, new Date("2026-10-15T19:00:00Z"))).toEqual({ removed: ["import:b1:class:2026-12-07"] });
  const ids = (store.listPlanVersions(ws)[0]!.payload as { blocks: Array<{ id: string }> }).blocks.map((item) => item.id);
  expect(ids).toEqual(["graph_calendar:x", "import:b1:final-2026-12-07", "import:b1:class:2026-12-04"]);
  expect(store.listEvents(ws, { type: "repair.import_duplicates" })[0]!.payload).toMatchObject({ removed: [blocks[1]] });
  expect(store.getSetting(ws, IMPORT_DUPLICATE_REPAIR)).toBe("2026-10-15T19:00:00.000Z");
  expect(repairDuplicateImports(store, ws, owner)).toBeUndefined();
});
