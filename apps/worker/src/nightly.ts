import { nightlyTrigger, type CostSignal, type NightlyTrigger } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { sampleLocalActivity } from "./activity";
import { LOCAL_ACTIVITY_CONSENT } from "./activity-recorder";

export const NIGHTLY_LAST_RUN = "flywheel.nightly.lastRunDay";
const OWNER_ID = "local-owner";

export type NightlyDeps = {
  store: CrosslineStore;
  workspaceId: string;
  readCost: () => Promise<CostSignal>;
  /** Runs the expansion. Returns how many proposals it produced, for the ledger. */
  expand: (budget: { headroomPercent: number; mode: string }) => Promise<number>;
};

/**
 * Decides whether tonight's expansion runs, and records the outcome either way.
 *
 * Every refusal is written to the ledger with its reason, so the morning can say "did not run, and
 * why" rather than showing yesterday's expansion as if it were new.
 */
export function createNightlyFlywheel(deps: NightlyDeps, options: {
  night?: { startHour: number; endHour: number };
  windowSharePercent?: number;
  longWindowCeilingPercent?: number;
  idleRequiredMs?: number;
} = {}) {
  const night = options.night ?? { startHour: 1, endHour: 4 };
  const spend = {
    windowSharePercent: options.windowSharePercent ?? 80,
    longWindowCeilingPercent: options.longWindowCeilingPercent ?? 90
  };
  const idleRequiredMs = options.idleRequiredMs ?? 20 * 60_000;

  return async function runNightly(now = new Date()): Promise<NightlyTrigger> {
    const cost = await deps.readCost();
    const consented = deps.store.getSetting(deps.workspaceId, LOCAL_ACTIVITY_CONSENT) === "granted";
    const sample = consented ? await sampleLocalActivity() : undefined;
    const resetsAt = [cost.available ? cost.short?.resetsAt : undefined, cost.available ? cost.long?.resetsAt : undefined]
      .filter((value): value is number => typeof value === "number");

    const decision = nightlyTrigger({
      now: now.toISOString(),
      resetsAt,
      night,
      cost,
      spend,
      ...(sample ? { idleMs: sample.idleMs } : {}),
      idleRequiredMs,
      ...(deps.store.getSetting(deps.workspaceId, NIGHTLY_LAST_RUN)
        ? { lastRunDay: deps.store.getSetting(deps.workspaceId, NIGHTLY_LAST_RUN)! }
        : {}),
      timeZoneOffsetMinutes: -now.getTimezoneOffset()
    });

    if (!decision.run) {
      // A skipped night is a fact worth keeping: without it the morning cannot tell stale from fresh.
      if (decision.code !== "BEFORE_PLANNED_TIME" && decision.code !== "ALREADY_RAN_TODAY") {
        deps.store.appendEvent({
          ownerId: OWNER_ID, workspaceId: deps.workspaceId,
          idempotencyKey: `flywheel:nightly:${now.toISOString().slice(0, 10)}:skipped`,
          type: "flywheel.nightly.skipped", entityId: "flywheel",
          payload: { code: decision.code, message: decision.message }
        });
      }
      return decision;
    }

    const localDay = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    // Claim the night before spending, so a crash mid-run cannot turn into a second run.
    deps.store.setSetting(deps.workspaceId, NIGHTLY_LAST_RUN, localDay);
    try {
      const proposals = await deps.expand({ headroomPercent: decision.headroomPercent, mode: decision.mode });
      deps.store.appendEvent({
        ownerId: OWNER_ID, workspaceId: deps.workspaceId,
        idempotencyKey: `flywheel:nightly:${localDay}:ran`,
        type: "flywheel.nightly.ran", entityId: "flywheel",
        payload: { proposals, headroomPercent: decision.headroomPercent, mode: decision.mode }
      });
    } catch (error) {
      deps.store.appendEvent({
        ownerId: OWNER_ID, workspaceId: deps.workspaceId,
        idempotencyKey: `flywheel:nightly:${localDay}:failed`,
        type: "flywheel.nightly.failed", entityId: "flywheel",
        payload: { code: "FLYWHEEL_RUN_FAILED", message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }
      });
    }
    return decision;
  };
}
