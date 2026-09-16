import { expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import type { CostSignal } from "@crossline/core";
import { createNightlyFlywheel, NIGHTLY_LAST_RUN } from "./nightly";
import { LOCAL_ACTIVITY_CONSENT } from "./activity-recorder";

vi.mock("./activity", () => ({ sampleLocalActivity: async () => ({ idleMs: 60_000, fgHandle: 7 }) }));

const healthy = (resetsAt: number): CostSignal => ({
  available: true, limitReached: false,
  short: { usedPercent: 5, windowDurationMins: 300, resetsAt },
  long: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: null }
});

/** A local time inside the 01:00–04:00 window, expressed in this machine's own zone. */
const localNight = (hour: number, minute = 0) => {
  const now = new Date();
  now.setHours(hour, minute, 0, 0);
  return now;
};

test("a refused night is written to the ledger, so the morning can tell stale from fresh", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const expand = vi.fn(async () => 0);
    const run = createNightlyFlywheel({
      store, workspaceId: "w", expand,
      readCost: async () => ({ available: false, reason: "supervisor down" })
    });
    const decision = await run(localNight(2));
    expect(decision).toMatchObject({ run: false, code: "COST_SIGNAL_UNAVAILABLE" });
    expect(expand).not.toHaveBeenCalled();
    expect(store.listEvents("w").map((event) => event.type)).toEqual(["flywheel.nightly.skipped"]);
  } finally { store.close(); }
});

test("the night is claimed before spending, so a crashed run cannot become a second run", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const at = localNight(2);
    const run = createNightlyFlywheel({
      store, workspaceId: "w",
      readCost: async () => healthy(Math.floor(at.getTime() / 1000)),
      expand: async () => { throw new Error("boom"); }
    });
    const decision = await run(new Date(at.getTime() + 6 * 60_000));
    expect(decision.run).toBe(true);
    expect(store.getSetting("w", NIGHTLY_LAST_RUN)).toBeDefined();
    expect(store.listEvents("w").map((event) => event.type)).toEqual(["flywheel.nightly.failed"]);

    // Same night again: the claim holds even though the first attempt failed.
    const second = await run(new Date(at.getTime() + 20 * 60_000));
    expect(second).toMatchObject({ run: false, code: "ALREADY_RAN_TODAY" });
  } finally { store.close(); }
});

test("an active keyboard defers the run only when activity collection was consented to", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const at = localNight(2);
    const deps = {
      store, workspaceId: "w",
      readCost: async () => healthy(Math.floor(at.getTime() / 1000)),
      expand: async () => 3
    };
    const later = new Date(at.getTime() + 6 * 60_000);

    // Without consent there is no sample, so the check is simply not made.
    expect(await createNightlyFlywheel(deps)(later)).toMatchObject({ run: true });

    store.setSetting("w", NIGHTLY_LAST_RUN, "");
    store.setSetting("w", LOCAL_ACTIVITY_CONSENT, "granted");
    // The mocked sample reports one minute idle: the person is still working.
    expect(await createNightlyFlywheel(deps)(later)).toMatchObject({ run: false, code: "USER_ACTIVE" });
  } finally { store.close(); }
});

test("a successful run records how much of the window it was allowed to use", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const at = localNight(1, 30);
    const run = createNightlyFlywheel({
      store, workspaceId: "w",
      readCost: async () => healthy(Math.floor(at.getTime() / 1000)),
      expand: async () => 4
    });
    await run(new Date(at.getTime() + 6 * 60_000));
    const event = store.listEvents("w").at(-1)!;
    expect(event.type).toBe("flywheel.nightly.ran");
    expect(event.payload).toMatchObject({ proposals: 4, mode: "normal", headroomPercent: 75 });
  } finally { store.close(); }
});
