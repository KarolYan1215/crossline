import {
  ACTIVITY_LONG_GAPS, ENERGY_ADVICE_PERIOD_DAYS, ENERGY_ADVICE_REVIEW_SCHEMA, ENERGY_ADVICE_SETTING, SLEEP_TRACKING_CONSENT, adviceId, adviceProfiles, energyAdviceRule,
  mergeSleep, readEnergyAdvice, resolveAvailability, sleepFromGaps, sleepFromPhoneEvents, spendAllows, validateEnergyAdviceReview, withAdjustments, workedRhythm, zoneClock,
  type BackgroundKind, type BackgroundSpend, type EnergyAdvice, type EnergyAdviceReview, type EnergyAdviceReviewRecord, type EnergyLevel, type PhoneSleepEvent, type SleepEpisode
} from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { claimedTitleMatches } from "./diligence";
import { localeOf, tOfWorkspace } from "./locale";
import { ownerOf } from "./owner";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";

export const ENERGY_ADVISOR = "crossline:crossline-energy-advisor";

const INSTRUCTIONS = "Review the rule-made energy advice against published research on sleep, circadian timing and alertness, and against "
  + "this person's own evidence. Search the web and open every page you cite; cite only pages you opened, by id. Keep the advice "
  + "(verdict agree), move one to four bands by one level (verdict adjust, each with sources), or say the record is too thin (verdict "
  + "insufficient). The person's own reports outrank general findings. Return raw JSON only.";

/**
 * The person's sleep as the web's energy model reads it (apps/web/lib/energy.ts): the screen's long idle stretches only with the 作息记录
 * consent, the phone's record and its bed and wake moments; a phone night wins over the screen's guess. The two phone settings are named
 * here as the web names them.
 */
export function sleepFor(store: CrosslineStore, workspaceId: string, hourOf: (iso: string) => number): SleepEpisode[] {
  const read = <T>(key: string, fallback: T): T => { try { const raw = store.getSetting(workspaceId, key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
  const screen = store.getSetting(workspaceId, SLEEP_TRACKING_CONSENT) === "granted" ? sleepFromGaps(read(ACTIVITY_LONG_GAPS, [] as Array<{ from: string; to: string }>), hourOf) : [];
  return mergeSleep(screen, [...read("health.sleep", [] as SleepEpisode[]), ...sleepFromPhoneEvents(read("health.events", [] as PhoneSleepEvent[]))]);
}

const zoneOf = (store: CrosslineStore, workspaceId: string): string => {
  try {
    const zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "{}") as { timeZone?: unknown }).timeZone;
    if (typeof zone === "string" && zone) { new Intl.DateTimeFormat("en", { timeZone: zone }); return zone; }
  } catch { /* the default below */ }
  return "America/Chicago";
};

/** The rule, from the ledger as it is now: sleep, the last eight weeks' self-reports and timed sessions, in the person's zone. */
export function energyAdviceInputs(store: CrosslineStore, workspaceId: string, now: Date) {
  const zone = zoneOf(store, workspaceId);
  const clock = zoneClock(zone);
  const since = new Date(now.getTime() - 56 * 86_400_000).toISOString();
  const reports = store.listEnergyObservations(workspaceId).filter((item) => item.source === "self_report" && item.level !== "uncalibrated" && item.observedAt >= since)
    .map((item) => ({ at: item.observedAt, level: item.level as EnergyLevel }));
  const sessions = store.listExecutions(workspaceId).filter((item) => item.endedAt && item.startedAt >= since);
  const worked = workedRhythm(sessions, zone, now.toISOString());
  const current = resolveAvailability({ saved: store.getSetting(workspaceId, "schedule.availability"),
    proposed: store.getSetting(workspaceId, "schedule.availability.proposed"), facts: store.listProfileFacts(workspaceId) });
  // The person's best hours as the web's energy model reads them: the first high-energy window of their pattern.
  const peak = current.windows.find((window) => window.energy === "high");
  const hourOf = (value: string) => { const [h, m] = value.split(":").map(Number); return (h ?? 0) + (m ?? 0) / 60; };
  return { zone, worked, current, rule: energyAdviceRule({ locale: localeOf(store, workspaceId), now: now.toISOString(), zone, episodes: sleepFor(store, workspaceId, clock.hour), reports, worked,
    statedPeak: peak ? { start: hourOf(peak.start), end: hourOf(peak.end) } : null }) };
}

/** Due once a week from the last advice (or the last 「not enough yet」). */
export function energyAdviceDue(store: CrosslineStore, workspaceId: string, now = new Date()): boolean {
  const last = readEnergyAdvice(store.getSetting(workspaceId, ENERGY_ADVICE_SETTING));
  return !last || now.getTime() - Date.parse(last.computedAt) >= ENERGY_ADVICE_PERIOD_DAYS * 86_400_000;
}

type Verified = { review: EnergyAdviceReview; dropped: number };

/** Each cited page opened with `safeGet` (public https on every hop) and its title matched; what rested only on a dropped page goes too. */
export async function verifyReview(review: EnergyAdviceReview, deps: SafeGetDeps): Promise<Verified> {
  const opened = new Set<string>();
  for (const source of review.sources) {
    const page = await safeGet(source.url, deps, { maxBytes: 3_000_000, timeoutMs: 20_000 }).catch(() => undefined);
    if (!page?.ok) continue;
    const text = page.contentType === "application/pdf" ? "" : htmlToText(new TextDecoder().decode(page.bytes)).slice(0, 20_000);
    // A PDF's title cannot be read without extracting it; it counts as opened.
    if (page.contentType === "application/pdf" || claimedTitleMatches(source.title, text)) opened.add(source.id);
  }
  const keep = <T extends { sourceIds: string[] }>(items: T[]) => items.map((item) => ({ ...item, sourceIds: item.sourceIds.filter((id) => opened.has(id)) }))
    .filter((item) => item.sourceIds.length > 0);
  return { review: { ...review, findings: keep(review.findings), adjustments: keep(review.adjustments), sources: review.sources.filter((source) => opened.has(source.id)) },
    dropped: review.sources.length - opened.size };
}

export type EnergyAdviceDeps = { client?: CodexRpcBoundary | undefined; review: boolean; safeGet?: SafeGetDeps; now?: Date;
  webBlocker?: () => { code: string; message: string } | undefined;
  /** Why the review is not run this week, when it is not. */ skippedBecause?: string };

/**
 * One week's advice: the rule, then (when allowed) the review with its sources verified, then stored as a suggestion. It never touches
 * the person's own pattern; the plan page shows the difference and the person decides.
 */
export async function computeEnergyAdvice(store: CrosslineStore, workspaceId: string, cwd: string, deps: EnergyAdviceDeps): Promise<EnergyAdvice> {
  const now = deps.now ?? new Date();
  const { rule, worked, current, zone } = energyAdviceInputs(store, workspaceId, now);
  const computedAt = now.toISOString();
  if ("insufficient" in rule) {
    const advice: EnergyAdvice = { computedAt, evidence: rule.evidence, insufficient: rule.insufficient };
    store.setSetting(workspaceId, ENERGY_ADVICE_SETTING, JSON.stringify(advice));
    return advice;
  }
  const t = tOfWorkspace(store, workspaceId);
  let review: EnergyAdviceReviewRecord = { state: "skipped", summary: deps.skippedBecause ?? t("本周未做联网复核"),
    findings: [], adjustments: [], droppedSources: 0 };
  let levels = rule.levels, sources: Array<{ id: string; url: string; title: string }> = [];
  const blocker = deps.review ? (deps.webBlocker ?? webResearchBlocker)() : undefined;
  if (deps.review && deps.client && !blocker) {
    const input = { version: "crossline.energy-advice-review.v1", today: computedAt.slice(0, 10), timeZone: zone,
      rule: { profiles: adviceProfiles(rule.levels), basis: rule.basis }, evidence: { ...rule.evidence,
        workedByHour: Array.from({ length: 24 }, (_, hour) => Math.round(worked.reduce((sum, row) => sum + (row[hour] ?? 0), 0) / 6) / 10) },
      current: current.windows };
    const result = await runCodexSkill(deps.client, input, { skillName: ENERGY_ADVISOR, cwd, developerInstructions: INSTRUCTIONS,
      outputSchema: ENERGY_ADVICE_REVIEW_SCHEMA, prepareInput: () => input, allowWebSearch: true, onAudit: () => {}, timeoutMs: 60 * 60_000,
      validateOutput: validateEnergyAdviceReview });
    if (result.ok) {
      const verified = await verifyReview(result.output, deps.safeGet ?? defaultSafeGetDeps());
      const adjusted = withAdjustments(rule.levels, verified.review.adjustments);
      levels = adjusted.levels;
      sources = verified.review.sources;
      const state = result.output.verdict === "insufficient" ? "insufficient"
        : !verified.review.sources.length ? "unverified"
        : adjusted.applied > 0 ? "adjusted" : "agreed";
      review = { state, summary: state === "unverified" ? t("联网复核引用的来源均未能打开，只保留规则结果") : result.output.summary,
        findings: verified.review.findings, adjustments: verified.review.adjustments, droppedSources: verified.dropped };
    } else review = { ...review, summary: t("联网复核未完成，只保留规则结果") };
  } else if (deps.review) review = { ...review, summary: t("联网复核暂不可用，只保留规则结果") };
  const advice: EnergyAdvice = { computedAt, evidence: rule.evidence, id: adviceId(levels), levels, ruleLevels: rule.levels,
    summary: review.state === "agreed" || review.state === "adjusted" ? review.summary : rule.summary, basis: rule.basis, review, sources };
  store.setSetting(workspaceId, ENERGY_ADVICE_SETTING, JSON.stringify(advice));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `energy.advice:${computedAt}`, type: "energy.advice.computed",
    entityId: workspaceId, payload: { id: advice.id, review: review.state, sources: sources.length, droppedSources: review.droppedSources } });
  return advice;
}

const running = new Set<string>();

/**
 * The weekly pass. Paused with 主线调研 on the background page; nothing at all for a workspace whose person has not acted in two days
 * (the rule costs nothing, but advice nobody looks at is not worth writing); the web-backed review only while the quota is normal.
 */
export async function energyAdvicePass(input: { store: CrosslineStore; workspaceId: string; cwd: string; client: () => CodexRpcBoundary | undefined;
  spend: () => Promise<BackgroundSpend>; paused: (kind: BackgroundKind) => boolean; enterUsage?: (workspaceId: string) => void }): Promise<void> {
  const { store, workspaceId } = input;
  if (running.has(workspaceId) || input.paused("research") || !energyAdviceDue(store, workspaceId)) return;
  const spend = await input.spend();
  if ((spend.engagement ?? "active") !== "active") return;
  running.add(workspaceId);
  try {
    input.enterUsage?.(workspaceId);
    const review = spendAllows(spend, "discretionary");
    const advice = await computeEnergyAdvice(store, workspaceId, input.cwd, { client: input.client(), review,
      ...(review ? {} : { skippedBecause: tOfWorkspace(store, workspaceId)("额度偏紧，本周未做联网复核") }) });
    console.info(JSON.stringify({ type: "energy.advice", workspaceId, ...("insufficient" in advice ? { insufficient: true } : { id: advice.id, review: advice.review.state }) }));
  } finally { running.delete(workspaceId); }
}
