import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { answerLine, energyRhythm, ONBOARDING_INSIGHTS, portraitConfirmedByInsights, portraitFingerprint, portraitStillConfirmed, PROFILE_CONFIRMED, readInsightRatings,
  type AccessContext, type EnergyLevel, type EnergyRhythm, type PortraitReport, type ProfileModel } from "@crossline/core";
import { interviewLocale, readLocale, sayDoFor } from "@crossline/db";
import { tFor } from "./i18n";
import { requestCodexSupervisor } from "./codex-runtime";
import { effectiveSchedulePreferences, getStore, readAvailability } from "./crossline";
import { energyModel } from "./energy";
import { currentFigure, figureUrl } from "./figures";
import { identityLines } from "./lines";
import { tOf } from "./locale";

export type PortraitState = {
  report: PortraitReport | null; version: number; at: string | null;
  /** The figure's address (`character`, the person's current figure, `figureUrl`), when there is one. */
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
  /** Whether the interview's portrait is written and whether the person said it fits (asked on this page since 2026-10-28). */
  confirmation: PortraitConfirmation;
  /** How the person says they look, the one description the figure is drawn from (`appearance` facts); empty when not said. */
  appearance: { text: string; skipped: boolean };
};
export type PortraitConfirmation = { written: boolean; confirmed: boolean; at: string | null };

const readJson = <T,>(raw: string | null | undefined, fallback: T): T => { try { return (JSON.parse(raw ?? "null") as T) ?? fallback; } catch { return fallback; } };

/**
 * The person's confirmation of the portrait, read exactly as the interview's checklist reads it (`interviewChecklistFor`): a 「符合」 on the
 * portrait as it stands now, or 「准」 on an observation in every deep stage. Written when the interview's portrait has its fields.
 */
export function portraitConfirmation(ctx: AccessContext): PortraitConfirmation {
  const store = getStore();
  const profile = readJson<Partial<ProfileModel>>(store.getSetting(ctx.workspaceId, "profile.model"), {});
  const confirmed = readJson<{ fingerprint?: string; at?: string } | null>(store.getSetting(ctx.workspaceId, PROFILE_CONFIRMED), null);
  const written = Boolean(String(profile.portrait ?? "").trim());
  const ok = portraitStillConfirmed(confirmed?.fingerprint, profile) || portraitConfirmedByInsights(readInsightRatings(store.getSetting(ctx.workspaceId, ONBOARDING_INSIGHTS)));
  return { written, confirmed: ok, at: ok ? confirmed?.at ?? null : null };
}

/** The appearance the person gave (the latest confirmed `appearance` fact), or that they chose a neutral figure. */
export function appearanceOf(ctx: AccessContext): { text: string; skipped: boolean } {
  const facts = getStore().listProfileFacts(ctx.workspaceId).filter((fact) => fact.identityId === "person" && fact.status === "confirmed");
  const said = facts.filter((fact) => fact.slot === "appearance").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  return { text: said?.value ?? "", skipped: !said && facts.some((fact) => fact.slot === "appearance_skipped") };
}

export function loadPortrait(ctx: AccessContext): PortraitState {
  const store = getStore();
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  let saved: { version?: number; at?: string; report?: PortraitReport } = {};
  try { saved = JSON.parse(store.getSetting(ctx.workspaceId, "portrait.report") ?? "{}"); } catch { /* none yet */ }
  const last = store.listEvents(ctx.workspaceId, { type: ["portrait.requested", "portrait.written", "portrait.blocked"] }).at(-1);
  const lines = identityLines(ctx);
  const milestones = store.listMilestones(ctx.workspaceId);
  // The person's figure, whichever report version drew it: a rewritten report keeps the figure (2026-10-21).
  const figure = currentFigure(ctx);
  return {
    report: saved.report ?? null, version: saved.version ?? 0, at: saved.at ?? null,
    images: figure ? { character: figureUrl(figure) } : {},
    sayDo: sayDoFor(store, ctx.workspaceId, now),
    rhythm: portraitRhythm(ctx, now),
    writing: last?.type === "portrait.requested" && Date.now() - Date.parse(last.createdAt) < 3_600_000,
    blocker: last?.type === "portrait.blocked" ? String((last.payload as { message?: string }).message ?? tOf(ctx)("未能生成")) : null,
    lines: lines.map((line) => ({ id: line.id, label: line.label, rank: line.rank ?? null, hard: Boolean(line.hard) })),
    next: {
      lines: lines.map((line) => ({ id: line.id, label: line.label,
        approved: milestones.filter((item) => item.identityId === line.id && item.status === "approved").map((item) => item.title),
        drafts: milestones.filter((item) => item.identityId === line.id && item.status === "draft").map((item) => item.title) })),
      hoursProposed: Boolean(store.getSetting(ctx.workspaceId, "schedule.availability.proposed")),
      hoursSet: Boolean(store.getSetting(ctx.workspaceId, "schedule.availability"))
    },
    confirmation: portraitConfirmation(ctx),
    appearance: appearanceOf(ctx)
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

/** The interview's own question about the portrait (`PORTRAIT_UNCONFIRMED`): its wording and options, so an answer here reads as one there. */
const CONFIRM_QUESTION = "「当前画像」写的是否符合本人？";
const CONFIRM_LABELS = { yes: "符合", mostly: "大体符合，有几处要改", no: "不符合" } as const;
export type PortraitAnswer = keyof typeof CONFIRM_LABELS;

/**
 * The person's answer to 「这份画像符合本人吗？」, given on the portrait page (2026-10-28, scenarios.md §3-10: the person can only judge it
 * having read it). 「符合」 is written exactly as the interview writes it — `profile.confirmed` with the fingerprint of the portrait as it
 * stands — so the checklist's item is done and the interview no longer asks. 「大体符合」 and 「不符合」 go to the interview as the person's
 * reply, in the interview's own words for that question, with what they want changed: the interview rewrites the portrait from it.
 */
export async function answerPortrait(ctx: AccessContext, answer: PortraitAnswer, note: string): Promise<{ ok: boolean; code?: string; message?: string }> {
  const store = getStore();
  const t = tOf(ctx);
  const now = new Date().toISOString();
  const profile = readJson<Partial<ProfileModel>>(store.getSetting(ctx.workspaceId, "profile.model"), {});
  if (!String(profile.portrait ?? "").trim()) return { ok: false, code: "PORTRAIT_NOT_WRITTEN", message: t("访谈还没有写出画像") };
  const ownerId = store.getWorkspaceOwnerId(ctx.workspaceId) ?? ctx.principalId;
  if (answer === "yes") {
    store.setSetting(ctx.workspaceId, PROFILE_CONFIRMED, JSON.stringify({ fingerprint: portraitFingerprint(profile), at: now }));
    store.appendEvent({ ownerId, workspaceId: ctx.workspaceId, idempotencyKey: `profile:confirmed:portrait:${now}`, type: "profile.confirmed",
      entityId: ctx.workspaceId, payload: { via: "portrait", ...(note ? { note } : {}) } });
    return { ok: true, message: t("已确认，访谈不再问这一题") };
  }
  if (!note.trim()) return { ok: false, code: "PORTRAIT_NOTE_REQUIRED", message: t("写一句哪里要改") };
  store.appendEvent({ ownerId, workspaceId: ctx.workspaceId, idempotencyKey: `profile:feedback:portrait:${now}`, type: "profile.portrait_feedback",
    entityId: ctx.workspaceId, payload: { answer, note } });
  const session = store.getLatestOnboardingSession(ctx.workspaceId);
  if (!session) return { ok: true, message: t("已记下") };
  const locale = interviewLocale(store, ctx.workspaceId) ?? readLocale(store, ctx.workspaceId);
  const said = tFor(locale);
  const text = answerLine(said(CONFIRM_QUESTION), [said(CONFIRM_LABELS[answer])], note.trim(), locale);
  // The interview takes it as the person's reply and rewrites the portrait; the page polls the report as it does while one is written.
  void requestCodexSupervisor(ctx, "/v1/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, text }), signal: AbortSignal.timeout(3 * 60 * 60_000) }).catch(() => undefined);
  return { ok: true, message: t("已交给访谈，画像随后按这句修改") };
}

/**
 * How the person says they look (2026-10-28: written on the figure card, beside 重画). Kept as a confirmed `appearance` fact about the
 * person — the one the interview's question writes — so the next figure is drawn from it (`figureRedrawDue` notices the change).
 * `skip` records 「不描述，用中性形象」 the same way.
 */
export function setAppearance(ctx: AccessContext, input: { text?: string; skip?: boolean }): { ok: boolean; code?: string } {
  const text = (input.text ?? "").trim().slice(0, 200);
  if (!text && !input.skip) return { ok: false, code: "APPEARANCE_EMPTY" };
  const value = text || tOf(ctx)("不描述，用中性形象");
  getStore().upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: "person", projectId: "", slot: text ? "appearance" : "appearance_skipped", value,
    status: "confirmed", sourceRef: "portrait-page", sourceQuote: value, updatedAt: new Date().toISOString() });
  return { ok: true };
}

/** Asks the worker to write (or rewrite) the portrait; answered at once. */
export async function requestPortrait(ctx: AccessContext, options: { redrawFigure?: boolean } = {}): Promise<{ ok: boolean }> {
  try {
    await requestCodexSupervisor(ctx, "/v1/portrait", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(options.redrawFigure ? { redrawFigure: true } : {}), signal: AbortSignal.timeout(10_000) });
    return { ok: true };
  } catch { return { ok: false }; }
}
