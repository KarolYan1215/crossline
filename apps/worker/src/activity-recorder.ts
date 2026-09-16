import type { CrosslineStore } from "@crossline/db";
import { aggregateSamples, sampleLocalActivity, type ActivitySample } from "./activity";

export const LOCAL_ACTIVITY_CONSENT = "localActivity.consent";
const OWNER_ID = "local-owner";

/**
 * Samples local activity on a timer and folds each day into one aggregate row.
 *
 * Nothing is sampled until consent is `granted`, and consent is re-read on every tick so revoking it
 * takes effect without restarting the worker. Raw samples never leave this object.
 */
export function createActivityRecorder(store: CrosslineStore, workspaceId: string, sampleIntervalMinutes = 1) {
  let day: string | undefined;
  let samples: ActivitySample[] = [];

  const flush = (observedAt: string) => {
    if (!day || !samples.length) return;
    const aggregate = aggregateSamples(samples, sampleIntervalMinutes);
    // The row records what was measured, not a judgement about it; levels come from `deriveCapacity`.
    store.upsertDailyActivity({
      ownerId: OWNER_ID, workspaceId, day,
      aggregate: { ...aggregate, sampleCount: samples.length },
      observedAt
    });
  };

  return async function record(now = new Date()): Promise<"skipped" | "recorded"> {
    if (store.getSetting(workspaceId, LOCAL_ACTIVITY_CONSENT) !== "granted") {
      samples = [];
      day = undefined;
      return "skipped";
    }
    const sample = await sampleLocalActivity();
    if (!sample) return "skipped";
    const today = now.toISOString().slice(0, 10);
    if (day && day !== today) { flush(`${day}T23:59:59.000Z`); samples = []; }
    day = today;
    samples.push(sample);
    flush(now.toISOString());
    return "recorded";
  };
}
