import "server-only";
import {
  NORM_NOTE, PROFILE_INSTRUMENTS_SETTING, PROFILE_ITEMS, PROFILE_SCALE_ANALYSIS_SETTING, PROFILE_SCALE_SETTING, SCALE_PAGES, SCALE_SUPPLEMENT_MAX,
  normalizeSelfReports, pointLabels, profileItem, readInstrumentAnswers, readScaleAnalysis, readScaleSession, scaleReport, scaleStatus, validScore,
  type AccessContext, type InstrumentAnswers, type ScaleAnalysis, type ScaleReport, type ScaleSession
} from "@crossline/core";
import { getStore } from "./crossline";
import { localeFor } from "./locale";

/**
 * The scale page (docs/plans/2026-11-22-interview-and-import-redesign.md §二.2): IPIP-NEO-120 and TwIVI on seven pages before the
 * interview's first round, paused and taken up again, with a free box that adds to the taps and the results of tests taken elsewhere
 * kept as the person said them (D12). The answers are the ledger's `PROFILE_INSTRUMENTS_SETTING`, the page's state `PROFILE_SCALE_SETTING`;
 * every change is an event. Once the person says it is done, the worker's extraction pass writes the analysis (`scale-analysis.ts`).
 */
export type ScaleItemView = { id: string; instrument: string; text: string; en: string; points: number; labels: readonly string[] };
export type ScaleState = {
  pages: ScaleItemView[][];
  answers: Record<string, { score?: number; skipped?: true }>;
  session: ScaleSession;
  status: ReturnType<typeof scaleStatus>;
  /** The scores once anything is answered; the page shows them only when the scale is done. */
  report: ScaleReport | null;
  analysis: ScaleAnalysis | null;
  norms: string;
};

const answersOf = (ctx: AccessContext) => readInstrumentAnswers(getStore().getSetting(ctx.workspaceId, PROFILE_INSTRUMENTS_SETTING));
const sessionOf = (ctx: AccessContext) => readScaleSession(getStore().getSetting(ctx.workspaceId, PROFILE_SCALE_SETTING));

export function loadScale(ctx: AccessContext): ScaleState {
  const locale = localeFor(ctx) === "en" ? "en" : "zh";
  const answers = answersOf(ctx);
  const session = sessionOf(ctx);
  return {
    pages: SCALE_PAGES.map((page) => page.map((item) => ({ id: item.id, instrument: item.instrument, text: item.text, en: item.en, points: item.points,
      labels: pointLabels(item, locale) }))),
    answers: Object.fromEntries(PROFILE_ITEMS.flatMap((item) => {
      const answer = answers[item.id];
      if (!answer) return [];
      return [[item.id, answer.by === "skipped" ? { skipped: true as const } : answer.score ? { score: answer.score } : {}]];
    })),
    session, status: scaleStatus(session, answers),
    report: Object.keys(answers).length ? scaleReport(answers) : null,
    analysis: readScaleAnalysis(getStore().getSetting(ctx.workspaceId, PROFILE_SCALE_ANALYSIS_SETTING)) ?? null,
    norms: NORM_NOTE
  };
}

export type ScaleChange =
  | { action: "answers"; answers: Array<{ itemId: string; score: number | null }> }
  | { action: "page"; page: number }
  | { action: "supplement"; text: string }
  | { action: "self_reports"; reports: unknown }
  | { action: "defer" | "resume" | "complete" };

/** Reads a change from a request body, or null when it is not one. */
export function readScaleChange(body: unknown): ScaleChange | null {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (value.action === "answers" && Array.isArray(value.answers) && value.answers.length <= PROFILE_ITEMS.length) {
    const answers = value.answers.flatMap((entry) => {
      const item = entry as { itemId?: unknown; score?: unknown } | null;
      return item && typeof item.itemId === "string" && (item.score === null || typeof item.score === "number") ? [{ itemId: item.itemId, score: item.score as number | null }] : [];
    });
    return answers.length === value.answers.length ? { action: "answers", answers } : null;
  }
  if (value.action === "page" && Number.isInteger(value.page)) return { action: "page", page: Number(value.page) };
  if (value.action === "supplement" && typeof value.text === "string" && value.text.length <= SCALE_SUPPLEMENT_MAX) return { action: "supplement", text: value.text };
  if (value.action === "self_reports" && Array.isArray(value.reports)) return { action: "self_reports", reports: value.reports };
  if (value.action === "defer" || value.action === "resume" || value.action === "complete") return { action: value.action };
  return null;
}

/**
 * Applies the person's change. A tap replaces whatever was recorded for the item (a mapping included); a null score is a skip. A score
 * off the item's own scale (a 6 on an IPIP item) is refused. 「做完了」 records the time the analysis is keyed to; doing the scale again
 * after it (an answer changed) asks for a new analysis only when the person presses it again.
 */
export function changeScale(ctx: AccessContext, change: ScaleChange): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const ws = ctx.workspaceId;
  const at = new Date().toISOString();
  const session = sessionOf(ctx);
  const save = (next: ScaleSession) => store.setSetting(ws, PROFILE_SCALE_SETTING, JSON.stringify(next));
  const event = (payload: Record<string, unknown>) => store.appendEvent({ ownerId: store.getWorkspaceOwnerId(ws) ?? ctx.principalId, workspaceId: ws,
    idempotencyKey: `profile.scale:${change.action}:${at}`, type: "profile.scale_changed", entityId: ws, payload: { action: change.action, ...payload } });
  if (change.action === "answers") {
    for (const entry of change.answers) {
      const item = profileItem(entry.itemId);
      if (!item) return { ok: false, code: "PROFILE_ITEM_UNKNOWN" };
      if (entry.score !== null && !validScore(item, entry.score)) return { ok: false, code: "PROFILE_ITEM_SCORE" };
    }
    const answers: InstrumentAnswers = answersOf(ctx);
    for (const entry of change.answers) answers[entry.itemId] = entry.score === null ? { itemId: entry.itemId, by: "skipped", at }
      : { itemId: entry.itemId, score: entry.score, by: "tapped", at };
    store.setSetting(ws, PROFILE_INSTRUMENTS_SETTING, JSON.stringify(answers));
    if (!session.startedAt) save({ ...session, startedAt: at });
    event({ answers: change.answers });
    return { ok: true };
  }
  if (change.action === "page") {
    if (change.page < 0 || change.page >= SCALE_PAGES.length) return { ok: false, code: "SCALE_PAGE_INVALID" };
    save({ ...session, page: change.page, startedAt: session.startedAt ?? at });
    return { ok: true };
  }
  if (change.action === "supplement") {
    save({ ...session, supplement: change.text.trim() });
    event({ length: change.text.trim().length });
    return { ok: true };
  }
  if (change.action === "self_reports") {
    const reports = normalizeSelfReports(change.reports);
    save({ ...session, selfReports: reports });
    event({ reports });
    return { ok: true };
  }
  if (change.action === "defer") { save({ ...session, deferredAt: at }); event({}); return { ok: true }; }
  if (change.action === "resume") { const { deferredAt: _gone, ...rest } = session; save(rest); event({}); return { ok: true }; }
  const { deferredAt: _gone, ...rest } = session;
  save({ ...rest, completedAt: at });
  event({ answered: scaleStatus(session, answersOf(ctx)).answered });
  return { ok: true };
}
