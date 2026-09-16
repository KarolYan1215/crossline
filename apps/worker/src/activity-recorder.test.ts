import { expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createActivityRecorder, LOCAL_ACTIVITY_CONSENT } from "./activity-recorder";

vi.mock("./activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./activity")>()),
  sampleLocalActivity: async () => ({ idleMs: 1_000, fgHandle: 42 })
}));

test("nothing is sampled until consent is granted, and revoking it stops collection immediately", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    const record = createActivityRecorder(store, "w", 1);
    expect(await record(new Date("2026-09-20T10:00:00.000Z"))).toBe("skipped");
    expect(store.listEnergyObservations("w")).toEqual([]);

    store.setSetting("w", LOCAL_ACTIVITY_CONSENT, "denied");
    expect(await record(new Date("2026-09-20T10:01:00.000Z"))).toBe("skipped");
    expect(store.listEnergyObservations("w")).toEqual([]);

    store.setSetting("w", LOCAL_ACTIVITY_CONSENT, "granted");
    expect(await record(new Date("2026-09-20T10:02:00.000Z"))).toBe("recorded");
    const observation = store.listEnergyObservations("w")[0]!;
    expect(observation.source).toBe("local_activity");
    // Only aggregates are persisted; no raw sample sequence and no handle identity.
    expect(Object.keys(observation.aggregate).sort()).toEqual(["activeMinutes", "idleMinutes", "sampleCount", "windowSwitches"]);
    expect(JSON.stringify(observation)).not.toContain("42");

    // The row records what was measured, never a judgement about it.
    expect(observation.level).toBe("uncalibrated");

    store.setSetting("w", LOCAL_ACTIVITY_CONSENT, "denied");
    expect(await record(new Date("2026-09-20T10:03:00.000Z"))).toBe("skipped");
  } finally { store.close(); }
});

test("one aggregate row per day, updated in place rather than appended per sample", async () => {
  const store = new CrosslineStore(":memory:");
  try {
    store.setSetting("w", LOCAL_ACTIVITY_CONSENT, "granted");
    const record = createActivityRecorder(store, "w", 1);
    for (let minute = 0; minute < 5; minute++) {
      await record(new Date(`2026-09-20T10:0${minute}:00.000Z`));
    }
    expect(store.listEnergyObservations("w")).toHaveLength(1);
    expect(store.listEnergyObservations("w")[0]?.aggregate.activeMinutes).toBe(5);
  } finally { store.close(); }
});
