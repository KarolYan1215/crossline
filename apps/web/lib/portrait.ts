import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { energyRhythm, type AccessContext, type EnergyLevel, type EnergyRhythm, type PortraitReport } from "@crossline/core";
import { sayDoFor } from "@crossline/db";
import { requestCodexSupervisor } from "./codex-runtime";
import { effectiveSchedulePreferences, getStore, readAvailability } from "./crossline";
import { energyModel } from "./energy";
import { identityLines } from "./lines";

export type PortraitState = {
  report: PortraitReport | null; version: number; at: string | null;
  /** Sections with an illustration drawn for this version (`/api/portrait/image/<slot>`), with when, for cache-busting. */
  images: Record<string, string>;
  /** What the execution record says was done, for the say–do comparison (drawn only once `sufficient`). */
  sayDo: ReturnType<typeof sayDoFor>;
  /** The energy model over one usual day, with the person's own reports, chronotype and sleep debt (the 「精力节律」 page). */
  rhythm: EnergyRhythm;
  /** Running (asked for within the last hour and not yet written or stopped), or stopped with a reason. */
  writing: boolean; blocker: string | null;
  lines: Array<{ id: string; label: string; rank: number | null; hard: boolean }>;
  /** What the app does next with this portrait (the private second half): milestones by line, and whether the hours are set. */
  next: { lines: Array<{ id: string; label: string; approved: string[]; drafts: string[] }>; hoursProposed: boolean; hoursSet: boolean };
};

export function loadPortrait(ctx: AccessContext): PortraitState {
  const store = getStore();
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  let saved: { version?: number; at?: string; report?: PortraitReport } = {};
  try { saved = JSON.parse(store.getSetting(ctx.workspaceId, "portrait.report") ?? "{}"); } catch { /* none yet */ }
  const last = store.listEvents(ctx.workspaceId, { type: ["portrait.requested", "portrait.written", "portrait.blocked"] }).at(-1);
  const lines = identityLines(ctx);
  const milestones = store.listMilestones(ctx.workspaceId);
  let drawn: { version?: number; images?: Record<string, { at?: string }> } = {};
  try { drawn = JSON.parse(store.getSetting(ctx.workspaceId, "portrait.images") ?? "{}"); } catch { /* none */ }
  return {
    report: saved.report ?? null, version: saved.version ?? 0, at: saved.at ?? null,
    images: drawn.version === saved.version ? Object.fromEntries(Object.entries(drawn.images ?? {}).map(([slot, image]) => [slot, image.at ?? ""])) : {},
    sayDo: sayDoFor(store, ctx.workspaceId, now),
    rhythm: portraitRhythm(ctx, now),
    writing: last?.type === "portrait.requested" && Date.now() - Date.parse(last.createdAt) < 3_600_000,
    blocker: last?.type === "portrait.blocked" ? String((last.payload as { message?: string }).message ?? "未能生成") : null,
    lines: lines.map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard) })),
    next: {
      lines: lines.map((line) => ({ id: line.id, label: line.label,
        approved: milestones.filter((item) => item.identityId === line.id && item.status === "approved").map((item) => item.title),
        drafts: milestones.filter((item) => item.identityId === line.id && item.status === "draft").map((item) => item.title) })),
      hoursProposed: Boolean(store.getSetting(ctx.workspaceId, "schedule.availability.proposed")),
      hoursSet: Boolean(store.getSetting(ctx.workspaceId, "schedule.availability"))
    }
  };
}

/** The energy model drawn over the person's usual day, in their own zone. */
function portraitRhythm(ctx: AccessContext, now: Date): EnergyRhythm {
  const model = energyModel(ctx, readAvailability(ctx));
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const reports = getStore().listEnergyObservations(ctx.workspaceId).filter((item) => item.source === "self_report" && item.level !== "uncalibrated")
    .map((item) => ({ at: item.observedAt, level: item.level as EnergyLevel }));
  return energyRhythm({ episodes: model.episodes, hourOf: model.hourOf, weekdayOf: (iso) => Number(formatInTimeZone(new Date(iso), zone, "i")),
    phaseShift: model.phaseShift, calibration: model.calibration, reports, now: now.toISOString() });
}

/** Asks the worker to write (or rewrite) the portrait; answered at once. */
export async function requestPortrait(ctx: AccessContext): Promise<{ ok: boolean }> {
  try {
    await requestCodexSupervisor(ctx, "/v1/portrait", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
    return { ok: true };
  } catch { return { ok: false }; }
}
