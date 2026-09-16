import { beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { GraphDeltaPage } from "@crossline/connectors";
import { createGraphSync } from "./graph-sync";

const WORKSPACE = "personal-crossline";
const NOW = () => new Date("2026-09-16T12:00:00.000Z");
const DAY = "2026-09-16";
let store: CrosslineStore;

beforeEach(() => { store = new CrosslineStore(":memory:"); });

const event = (id: string, subject: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  provider: "graph_calendar", externalId: id, title: subject,
  start: `${DAY}T${from}:00.000Z`, end: `${DAY}T${to}:00.000Z`, ...extra
});

/** Answers each call with `pages[n]`, so a test can drive a resync or a multi-page stream. */
const reader = (pages: GraphDeltaPage[]) => {
  let call = 0;
  return { pullCalendar: async () => pages[Math.min(call++, pages.length - 1)]!, calls: () => call };
};

const seedPlan = (status: "draft" | "approved", blocks: unknown[]) => {
  store.savePlanVersion({ id: "plan-1", ownerId: "local-owner", workspaceId: WORKSPACE,
    version: 1, status, payload: { blocks } });
};
const imported = (id: string, title: string, start: string, end: string) =>
  ({ id: `graph_calendar:${id}`, lane: "human", title, start, end, source: "日历", readOnly: true });

test("calendar events become read-only reality blocks on the day plan", async () => {
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [event("a", "组会", "06:00", "07:00")], cursor: "delta-1" }]),
    now: NOW, timeZone: "UTC"
  });
  seedPlan("draft", []);
  const outcome = await sync();

  expect(outcome).toMatchObject({ state: "synced", imported: 1, changes: 1 });
  const blocks = (store.listPlanVersions(WORKSPACE)[0]?.payload as { blocks: Array<Record<string, unknown>> }).blocks;
  // Read-only because the calendar owns it: an edit here would diverge and the next sync would undo it.
  expect(blocks[0]).toMatchObject({ id: "graph_calendar:a", title: "组会", start: "06:00", end: "07:00", readOnly: true });
  expect(store.readSyncCursor(WORKSPACE, "graph_calendar", "calendarView")).toBe("delta-1");
});

test("a draft plan is updated in place; blocks the user authored are kept", async () => {
  seedPlan("draft", [imported("a", "组会", "06:00", "07:00"),
    { id: "mine", lane: "human", title: "深度工作", start: "08:00", end: "09:00", source: "自建", readOnly: false }]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [event("a", "组会", "06:30", "07:30")], cursor: "delta-2" }]),
    now: NOW, timeZone: "UTC"
  });
  await sync();

  const plans = store.listPlanVersions(WORKSPACE);
  // Nothing was agreed yet, so the draft absorbs the change rather than forking.
  expect(plans).toHaveLength(1);
  expect(plans[0]?.status).toBe("draft");
  const blocks = (plans[0]?.payload as { blocks: Array<Record<string, unknown>> }).blocks;
  expect(blocks.find((block) => block.id === "graph_calendar:a")).toMatchObject({ start: "06:30" });
  expect(blocks.find((block) => block.id === "mine")).toMatchObject({ title: "深度工作" });
  expect(store.listPlanChanges("plan-1").map((change) => change.kind)).toEqual(["move"]);
});

test("an approved plan is never rewritten: reality moving becomes a new draft of conflicts", async () => {
  seedPlan("approved", [imported("a", "组会", "06:00", "07:00")]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [event("a", "组会", "09:00", "10:00")], cursor: "delta-3" }]),
    now: NOW, timeZone: "UTC"
  });
  const outcome = await sync();

  const approved = store.listPlanVersions(WORKSPACE).find((plan) => plan.id === "plan-1");
  expect(approved?.status).toBe("approved");
  // The plan you agreed to still says what it said; the disagreement is a separate draft.
  expect((approved?.payload as { blocks: Array<Record<string, unknown>> }).blocks[0]).toMatchObject({ start: "06:00" });
  const draftId = (outcome as { planVersionId: string }).planVersionId;
  expect(draftId).not.toBe("plan-1");
  const changes = store.listPlanChanges(draftId);
  expect(changes.map((change) => change.kind)).toEqual(["conflict"]);
  expect(changes[0]?.explanation).toContain("06:00");
});

test("a conflict can actually be resolved, so a plan is not permanently unapprovable", async () => {
  seedPlan("approved", [imported("a", "组会", "06:00", "07:00")]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [event("a", "组会", "09:00", "10:00")], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  const outcome = await sync();
  const draftId = (outcome as { planVersionId: string }).planVersionId;
  const change = store.listPlanChanges(draftId)[0]!;

  expect(store.resolvePlanChange(WORKSPACE, change.id, "excluded", "k1")).toEqual({ changed: true });
  expect(store.listPlanChanges(draftId)[0]?.status).toBe("excluded");
  // Resolving twice is not a second decision.
  expect(store.resolvePlanChange(WORKSPACE, change.id, "approved", "k2")).toEqual({ changed: false });
  expect(store.listEvents("personal-crossline").filter((e) => e.type === "plan_change.resolved")).toHaveLength(1);
});

test("a deleted event is removed even when its tombstone arrives after its creation", async () => {
  seedPlan("draft", [imported("a", "组会", "06:00", "07:00")]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [
      event("a", "组会", "06:00", "07:00"),
      { ...event("a", "组会", "06:00", "07:00"), removed: true }
    ], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  await sync();
  const blocks = (store.listPlanVersions(WORKSPACE)[0]?.payload as { blocks: unknown[] }).blocks;
  expect(blocks).toEqual([]);
  expect(store.listPlanChanges("plan-1").map((change) => change.kind)).toEqual(["remove"]);
});

test("a resync drops what the gap deleted, even though no tombstone ever arrives for it", async () => {
  seedPlan("draft", [imported("a", "组会", "06:00", "07:00"), imported("b", "课程", "08:00", "09:00")]);
  const sync = createGraphSync(store, WORKSPACE, {
    // Graph answers 410: the cursor is too old. The retry returns the CURRENT state, and "b" is simply
    // absent — deletions during the gap are never replayed as tombstones.
    reader: reader([{ items: [], resyncRequired: true }, { items: [event("a", "组会", "06:00", "07:00")], cursor: "fresh" }]),
    now: NOW, timeZone: "UTC"
  });
  const outcome = await sync();

  expect(outcome).toMatchObject({ state: "synced", resynced: true });
  const blocks = (store.listPlanVersions(WORKSPACE)[0]?.payload as { blocks: Array<Record<string, unknown>> }).blocks;
  expect(blocks.map((block) => block.id)).toEqual(["graph_calendar:a"]);
  expect(store.readSyncCursor(WORKSPACE, "graph_calendar", "calendarView")).toBe("fresh");
});

test("an event that is not a block on today's strip is counted, not silently dropped", async () => {
  seedPlan("draft", []);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [
      // A multi-day trip would be drawn as a bar burying every real commitment beneath it.
      event("trip", "出差", "06:00", "07:00", { end: "2026-09-19T07:00:00.000Z" }),
      { provider: "graph_calendar", externalId: "noTime", title: "全天" }
    ], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  // Reported as skipped so the day is not presented as emptier than it is.
  expect(await sync()).toMatchObject({ state: "synced", imported: 0, skipped: 2 });
});

test("a failed read leaves the plan exactly as it was", async () => {
  seedPlan("approved", [imported("a", "组会", "06:00", "07:00")]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: { pullCalendar: async () => { throw new Error("GRAPH_READ_FAILED:503"); } },
    now: NOW, timeZone: "UTC"
  });
  expect(await sync()).toMatchObject({ state: "blocked", code: "GRAPH_READ_FAILED" });
  expect(store.listPlanVersions(WORKSPACE)).toHaveLength(1);
  // Losing the cursor would force a full re-read; a transient failure must not cost that.
  expect(store.readSyncCursor(WORKSPACE, "graph_calendar", "calendarView")).toBeNull();
});

test("the plan carries a week of reality, not just today", async () => {
  // Importing only today threw away twenty of every twenty-one events already paid for, and left the
  // A lens week view with nothing to show.
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [
      event("today", "今天的组会", "06:00", "07:00"),
      { ...event("tomorrow", "明天的课", "14:00", "15:00"),
        start: "2026-09-17T14:00:00.000Z", end: "2026-09-17T15:00:00.000Z" },
      // Beyond the seven-day window: read, but not carried into the plan.
      { ...event("far", "下个月", "14:00", "15:00"),
        start: "2026-10-20T14:00:00.000Z", end: "2026-10-20T15:00:00.000Z" }
    ], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  seedPlan("draft", []);
  expect(await sync()).toMatchObject({ state: "synced", imported: 2 });

  const blocks = (store.listPlanVersions(WORKSPACE)[0]?.payload as { blocks: Array<Record<string, string>> }).blocks;
  expect(blocks.map((block) => `${block.day} ${block.start}`)).toEqual(["2026-09-16 06:00", "2026-09-17 14:00"]);
});

test("a block from before the plan carried days is not reported as having moved", async () => {
  // Upgrade case: the stored block has no `day`. It was a block for the day it was imported on, so it
  // reads as today — otherwise the first sync after the upgrade calls every imported block a move.
  seedPlan("draft", [{ id: "graph_calendar:a", lane: "human", title: "组会",
    start: "06:00", end: "07:00", source: "日历", readOnly: true }]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [event("a", "组会", "06:00", "07:00")], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  expect(await sync()).toMatchObject({ state: "synced", changes: 0 });
});

test("a day change on an approved plan is described with the date, not just the clock", async () => {
  seedPlan("approved", [{ id: "graph_calendar:a", lane: "human", title: "组会", day: "2026-09-16",
    start: "06:00", end: "07:00", source: "日历", readOnly: true }]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [{ ...event("a", "组会", "06:00", "07:00"),
      start: "2026-09-18T06:00:00.000Z", end: "2026-09-18T07:00:00.000Z" }], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  const outcome = await sync();
  const change = store.listPlanChanges((outcome as { planVersionId: string }).planVersionId)[0];
  expect(change?.kind).toBe("conflict");
  // "moved to 9/18" is the fact that matters; two identical clock times would read as no change at all.
  expect(change?.explanation).toContain("9/18");
});

test("a long calendar id keeps add and move as separate changes", async () => {
  // A real Graph event id is ~150 characters and two events in one mailbox share almost all of it.
  // Truncating the change id to fit cut the kind suffix off, so a move upserted onto the earlier add
  // row: the C lens showed 新增 next to text describing a move.
  const longId = `AAMkADE0${"A".repeat(140)}==`;
  const longEvent = (from: string, to: string) => ({
    provider: "graph_calendar", externalId: longId, title: "组会",
    start: `${DAY}T${from}:00.000Z`, end: `${DAY}T${to}:00.000Z`
  });
  seedPlan("draft", []);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([
      { items: [longEvent("06:00", "07:00")], cursor: "c1" },
      { items: [longEvent("09:00", "10:00")], cursor: "c2" }
    ]),
    now: NOW, timeZone: "UTC"
  });
  await sync();
  await sync();

  const kinds = store.listPlanChanges("plan-1").map((change) => change.kind).sort();
  expect(kinds).toEqual(["add", "move"]);
  const ids = store.listPlanChanges("plan-1").map((change) => change.id);
  expect(new Set(ids).size).toBe(2);
  expect(ids.every((id) => id.length < 120)).toBe(true);
});

test("a block that aged out of the window is not reported as deleted", async () => {
  // Otherwise every morning produces a "已不存在" change for yesterday, and a weekly meeting looks
  // deleted every week as last week's occurrence rolls off the front of the window.
  seedPlan("draft", [{ id: "graph_calendar:yesterday", lane: "human", title: "昨天的组会",
    day: "2026-09-15", start: "11:00", end: "12:00", source: "日历", readOnly: true }]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [event("today", "今天的课", "06:00", "07:00")], cursor: "c" }]),
    now: NOW, timeZone: "UTC"
  });
  const outcome = await sync();

  expect(store.listPlanChanges("plan-1").map((change) => change.kind)).toEqual(["add"]);
  expect(outcome).toMatchObject({ changes: 1 });
});

test("a block inside the window that really disappeared is still reported", async () => {
  seedPlan("draft", [{ id: "graph_calendar:soon", lane: "human", title: "后天的会",
    day: "2026-09-18", start: "11:00", end: "12:00", source: "日历", readOnly: true }]);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([{ items: [], cursor: "c" }]), now: NOW, timeZone: "UTC"
  });
  await sync();
  const changes = store.listPlanChanges("plan-1");
  expect(changes.map((change) => change.kind)).toEqual(["remove"]);
  expect(changes[0]?.explanation).toContain("9/18");
});

test("an incremental page lists what changed, not the whole calendar", async () => {
  // The second tick returns an empty delta because nothing changed. Treating that as the authoritative
  // set wiped the plan and reported every block as deleted — the sync destroyed its own work daily.
  seedPlan("draft", []);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([
      { items: [event("a", "组会", "06:00", "07:00")], cursor: "c1" },
      { items: [], cursor: "c2" }
    ]),
    now: NOW, timeZone: "UTC"
  });
  await sync();
  const second = await sync();

  expect(second).toMatchObject({ state: "synced", imported: 1, changes: 0 });
  const blocks = (store.listPlanVersions(WORKSPACE)[0]?.payload as { blocks: Array<Record<string, string>> }).blocks;
  expect(blocks.map((block) => block.id)).toEqual(["graph_calendar:a"]);
});

test("an incremental page still applies its tombstones", async () => {
  seedPlan("draft", []);
  const sync = createGraphSync(store, WORKSPACE, {
    reader: reader([
      { items: [event("a", "组会", "06:00", "07:00"), event("b", "课程", "08:00", "09:00")], cursor: "c1" },
      { items: [{ ...event("a", "组会", "06:00", "07:00"), removed: true }], cursor: "c2" }
    ]),
    now: NOW, timeZone: "UTC"
  });
  await sync();
  await sync();
  const blocks = (store.listPlanVersions(WORKSPACE)[0]?.payload as { blocks: Array<Record<string, string>> }).blocks;
  // "a" was explicitly tombstoned; "b" was simply not mentioned, which means unchanged.
  expect(blocks.map((block) => block.id)).toEqual(["graph_calendar:b"]);
});
