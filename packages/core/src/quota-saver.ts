import { thinkingVariant, tokenYuan, type SponsorModel, type UsageForPrice } from "./sponsor";

/**
 * 节省额度 (2026-10-21, the owner's decision; docs/token-economy.md §2.3): with it on — the default — background work nobody waits on is
 * held to a share of the person's week and runs only while the quota is normal or at night. One switch on 设置 → 后台任务, no figures
 * shown; the weighted cost below is kept in the background to decide it.
 *
 * Non-core is what the worker runs under `NON_CORE_PURPOSE` (and passes `nonCore` to `spendAllows` for): the public skills' monthly
 * search and its reviews, compiling a line's own skill (insight compiler), line research (diligence), the nightly flywheel, portrait
 * rewrites, archetype curation and energy advice. Everything the person waits on or that turns their own input into work — the interview,
 * the input box, capture analysis, step plans, backplanning, mail, the gate, the assistant — is never held by it.
 */
export const QUOTA_SAVER_SETTING = "background.quotaSaver";
/** The week (its Monday, `YYYY-MM-DD` in the person's zone) the person was last told non-core work stopped for it. */
export const QUOTA_SAVER_TOLD_SETTING = "background.quotaSaver.told";
export const NON_CORE_PURPOSE = "non_core";
/** The share of the account's weighted cost in a week that non-core work may reach. */
export const NON_CORE_WEEKLY_SHARE = 0.2;
/** The person's night, in their zone: non-core work may run then whatever the quota reading says (within the share). */
export const QUOTA_SAVER_NIGHT = { fromHour: 23, toHour: 7 } as const;

/** On unless the person turned it off; anything unreadable reads as on. */
export const quotaSaverOn = (raw: string | undefined | null): boolean => raw !== "off";

/**
 * How the ChatGPT quota counts a run's tokens: a cached input token at a tenth of a new one (Codex's pricing page), an output token
 * (reasoning included) at `OUTPUT_WEIGHT` — **an estimate, not confirmed**: output is known to cost far more than input, the factor is
 * not published. Measured on the hosted beta 2026-10-17..22 this made output and uncached input the real spend.
 */
export const CACHED_INPUT_WEIGHT = 0.1;
export const OUTPUT_WEIGHT = 8;

type Tokens = { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
/** Uncached input + 0.1 × cached input + K × output, in input-token units. */
export function weightedTokens(usage: Tokens): number {
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  return usage.inputTokens - cached + CACHED_INPUT_WEIGHT * cached + OUTPUT_WEIGHT * usage.outputTokens;
}

/**
 * One run's (or one sum's) weighted cost: always the weighted tokens, plus yuan at the listed prices when it ran on one of the developer's
 * models (`tokenYuan`, cache-hit price where the model has one). The saver compares shares in weighted tokens, one scale for every route.
 */
export function runCost(usage: UsageForPrice, sponsorModels: SponsorModel[] = []): { weightedTokens: number; yuan?: number } {
  const price = sponsorModels.find((model) => model.model === thinkingVariant(usage.model).base);
  return { weightedTokens: weightedTokens(usage), ...(price ? { yuan: tokenYuan(usage, price) } : {}) };
}

/** Whether non-core work has reached its share: over `NON_CORE_WEEKLY_SHARE` of everything the account ran this week. */
export function nonCoreOverShare(nonCore: number, total: number): boolean {
  return nonCore > NON_CORE_WEEKLY_SHARE * total;
}

const wall = (date: Date, zone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(date).map((part) => [part.type, part.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, min: Number(parts.minute), s: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "") };
};

/** The instant the person's week began: Monday 00:00 in their zone, and that Monday as `YYYY-MM-DD`. */
export function zoneWeekStart(now: Date, zone: string): { at: string; day: string } {
  const local = wall(now, zone);
  const monday = new Date(Date.UTC(local.y, local.m - 1, local.d - ((local.weekday + 6) % 7)));
  // Wall-clock midnight to an instant: subtract the zone's offset there, measured twice so a change of offset that week is followed.
  let at = monday.getTime();
  for (let i = 0; i < 2; i += 1) {
    const seen = wall(new Date(at), zone);
    at -= Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min, seen.s) - monday.getTime();
  }
  return { at: new Date(at).toISOString(), day: monday.toISOString().slice(0, 10) };
}

/** 23:00–07:00 in the person's zone. */
export function inPersonNight(now: Date, zone: string): boolean {
  const hour = wall(now, zone).h;
  return hour >= QUOTA_SAVER_NIGHT.fromHour || hour < QUOTA_SAVER_NIGHT.toHour;
}

/** What `spendAllows` needs to apply the saver; `week` names the week so the person is told once per week. */
export type QuotaSaver = { on: boolean; night: boolean; overShare: boolean; week: string };

/** The saver's reading for one moment, from the week's usage sums (`modelUsageByPurpose`). */
export function quotaSaverReading(input: { raw: string | undefined | null; now: Date; zone: string;
  usage: ReadonlyArray<Tokens & { purpose: string }> }): QuotaSaver {
  const total = input.usage.reduce((sum, row) => sum + weightedTokens(row), 0);
  const nonCore = input.usage.filter((row) => row.purpose === NON_CORE_PURPOSE).reduce((sum, row) => sum + weightedTokens(row), 0);
  return { on: quotaSaverOn(input.raw), night: inPersonNight(input.now, input.zone), overShare: nonCoreOverShare(nonCore, total),
    week: zoneWeekStart(input.now, input.zone).day };
}
