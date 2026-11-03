import {
  DEVICE_LOCATION_SETTING, VISA_CACHE_SETTING, VISA_LEAD_FALLBACK_DAYS, VISA_READING_SCHEMA, clashSentence, feasibilityOf, freshVisa, readDeviceLocation,
  readVisaCache, tFor, validateVisaReading, visaCheckFrom, visaKey, zonedParts,
  type CalendarClash, type GeoPoint, type GeoQuery, type VisaCheck, type VisaReading
} from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import { calendarBlocksOf, deviceLocationOn, feasibilityContextFor, prepDaysOf, zoneOfWorkspace, type CrosslineStore, type StoredOpportunity } from "@crossline/db";
import { geocoderFor, type GeoDeps } from "./geo";
import { localeOf } from "./locale";
import type { FeasibilityFn } from "./opportunities";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";
import { sayToPerson } from "./workflow-smith";

/**
 * The time–space engine's worker half (docs/opportunity-agent.md §17.6–17.7, track ②). Each pass, for the opportunities still open:
 * the person's places and the events' cities are geocoded (cached, paced, a budget per pass), the visa for an event abroad is looked up on
 * the official page (`crossline-visa-finder` finds and quotes it; code opens the page, checks the quotes and reads the days), and a clash
 * with a fixed arrangement on the calendar is told to the person at once. The web judges each card again on read, with the plan's own work
 * blocks and these caches; nothing here decides what is shown.
 */
export const VISA_FINDER = "crossline:crossline-visa-finder";
/** Fingerprints of clashes already told (`{ [fingerprint]: iso }`), so one clash is one message. */
export const CLASH_SAID_SETTING = "opportunity.clashSaid";
/** Single messages are capped like the other urgent ones (notify.ts): a day's clashes beyond this wait for the next day. */
export const CLASH_MESSAGES_PER_DAY = 3;
export const CLASH_NUDGE_KIND = "opportunity_clash";
/** Visa lookups tried and not settled (`{ [key]: iso }`): tried again after a day, so a failing lookup is not a model run every tick. */
const VISA_TRIED_SETTING = "visa.tried";
const GEO_LOOKUPS_PER_PASS = 12;
const VISA_LOOKUPS_PER_PASS = 2;
const VISA_INSTRUCTIONS = "Find the official government page on whether a citizen of the given country needs a visa for a short visit to the "
  + "destination for the given purpose. Copy the deciding sentence and the processing-time sentence verbatim; never state a number of days "
  + "yourself, code reads it from the sentence. Only government hosts; none found is a valid answer. Return raw JSON only.";

export type TimeSpaceDeps = { client: () => CodexRpcBoundary | undefined; cwd: string; http?: SafeGetDeps; geo?: GeoDeps; now?: () => Date;
  webBlocker?: typeof webResearchBlocker };

const readJson = <T>(store: CrosslineStore, workspaceId: string, key: string, fallback: T): T => {
  try { const raw = store.getSetting(workspaceId, key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
};

/**
 * One visa lookup: the Skill names official pages, each is opened here and checked (`visaCheckFrom`); the first verified reading wins,
 * else the first page with a verdict but no processing sentence (kept as the source, fallback lead, unverified), else the fallback alone.
 * The answer is cached; a lookup the runtime could not make is not, and is tried again after a day.
 */
export async function findVisa(store: CrosslineStore, workspaceId: string, citizenship: string, destination: string, deps: TimeSpaceDeps): Promise<VisaCheck | undefined> {
  const now = deps.now?.() ?? new Date();
  const key = visaKey(citizenship, destination);
  const cached = freshVisa(readVisaCache(store.getSetting(workspaceId, VISA_CACHE_SETTING)), citizenship, destination, now);
  if (cached) return cached;
  const tried = readJson<Record<string, string>>(store, workspaceId, VISA_TRIED_SETTING, {});
  if (tried[key] && now.getTime() - Date.parse(tried[key]) < 86_400_000) return undefined;
  store.setSetting(workspaceId, VISA_TRIED_SETTING, JSON.stringify({ ...tried, [key]: now.toISOString() }));
  const client = deps.client();
  if (!client || (deps.webBlocker ?? webResearchBlocker)()) return undefined;
  const input = { version: "crossline.visa.v1", citizenship, destination, purpose: "a short event: a conference, competition or programme of up to a few weeks" };
  const result = await runCodexSkill<VisaReading>(client, input, {
    skillName: VISA_FINDER, cwd: deps.cwd, developerInstructions: VISA_INSTRUCTIONS, outputSchema: VISA_READING_SCHEMA as unknown as Record<string, unknown>,
    prepareInput: () => input, allowWebSearch: true, validateOutput: (output) => validateVisaReading(output as VisaReading), onAudit: () => {}, timeoutMs: 30 * 60_000
  });
  if (!result.ok) return undefined;
  const checkedAt = now.toISOString();
  const http = deps.http ?? defaultSafeGetDeps();
  let fallback: VisaCheck | undefined;
  let found: VisaCheck | undefined;
  for (const page of result.output.pages.slice(0, 3)) {
    const fetched = await safeGet(page.url, http, { maxBytes: 3_000_000, timeoutMs: 30_000, types: ["text/html", "application/xhtml+xml", "text/plain"] }).catch(() => undefined);
    if (!fetched?.ok) continue;
    const check = visaCheckFrom(page, htmlToText(new TextDecoder().decode(fetched.bytes)), checkedAt);
    if (check?.verified) { found = check; break; }
    fallback ??= check;
  }
  const answer = found ?? fallback ?? { needed: "unknown" as const, leadDays: VISA_LEAD_FALLBACK_DAYS, checkedAt, verified: false };
  const cache = readVisaCache(store.getSetting(workspaceId, VISA_CACHE_SETTING));
  store.setSetting(workspaceId, VISA_CACHE_SETTING, JSON.stringify({ ...cache, [key]: answer }));
  return answer;
}

/**
 * Track ②'s verdict as track ①'s `Clients.feasibility` (§17.6), for the watch runs and the scout: a find is judged before it is kept, so
 * one that cannot be reached is held back. The lead is the watch's (none for an event one turns up to), the local limit the watch's radius
 * (「少来·太远」 tightens it); geocodes and visas go through the same cached, paced lookups as `timeSpacePass`.
 */
export function discoveryFeasibility(deps: TimeSpaceDeps): FeasibilityFn {
  return async (opportunity, { store, workspaceId, now, watch }) => {
    const geocoder = geocoderFor(store, workspaceId, { ...deps.geo, ...(deps.http && !deps.geo?.http ? { http: deps.http } : {}), now: () => now });
    const prepDays = opportunity.kind === "event" ? 0 : watch?.leadDays ?? prepDaysOf(store, workspaceId, opportunity);
    return feasibilityOf(opportunity, feasibilityContextFor(store, workspaceId, { now, prepDays, locale: localeOf(store, workspaceId),
      geocode: async (query) => geocoder.cached(query) ?? geocoder.geocode(query),
      visa: (citizenship, destination) => findVisa(store, workspaceId, citizenship, destination, { ...deps, now: () => now }),
      ...(watch?.radiusMinutes ? { localMinutesMax: watch.radiusMinutes } : {}) }));
  };
}

/** Still in front of the person: not decided (or put off to later), not ineligible, and with a deadline or start ahead. */
const openOpportunity = (row: StoredOpportunity) => (!row.decision || row.decision === "later") && row.verdict.state !== "ineligible";

/** Daytime in the person's zone: a clash is not sent at night (it waits for the morning pass). */
const daytime = (now: Date, zone: string) => { const hour = Number(zonedParts(now.getTime(), zone).clock.slice(0, 2)); return hour >= 8 && hour < 23; };

export async function timeSpacePass(store: CrosslineStore, workspaceId: string, deps: TimeSpaceDeps): Promise<{ judged: number; told: number; geocoded: number; visas: number }> {
  const now = deps.now?.() ?? new Date();
  const geocoder = geocoderFor(store, workspaceId, { ...deps.geo, ...(deps.http && !deps.geo?.http ? { http: deps.http } : {}), now: () => deps.now?.() ?? new Date() });
  let geoBudget = GEO_LOOKUPS_PER_PASS, visaBudget = VISA_LOOKUPS_PER_PASS, geocoded = 0, visas = 0;
  const geocode = async (query: GeoQuery): Promise<GeoPoint | undefined> => {
    const hit = geocoder.cached(query);
    if (hit || geoBudget <= 0) return hit;
    geoBudget -= 1; geocoded += 1;
    return geocoder.geocode(query);
  };

  // The device reading names its town once (city level), so the card can say where the person is without showing coordinates.
  if (deviceLocationOn(store, workspaceId)) {
    const reading = readDeviceLocation(store.getSetting(workspaceId, DEVICE_LOCATION_SETTING));
    if (reading && !reading.city && geoBudget > 0) {
      geoBudget -= 1; geocoded += 1;
      const town = await geocoder.reverse(reading.lat, reading.lon);
      const latest = readDeviceLocation(store.getSetting(workspaceId, DEVICE_LOCATION_SETTING));
      // Only onto the same reading, and only while the consent still stands: turning it off meanwhile deleted it.
      if (town && latest && latest.at === reading.at && deviceLocationOn(store, workspaceId)) {
        store.setSetting(workspaceId, DEVICE_LOCATION_SETTING, JSON.stringify({ ...latest, city: town.city, country: town.country }));
      }
    }
  }

  const rows = store.listOpportunities(workspaceId).filter(openOpportunity);
  if (!rows.length) return { judged: 0, told: 0, geocoded, visas };
  // The places of the coming weeks named on the calendar are geocoded first, so a trip away counts before an event is judged against home.
  const zone = zoneOfWorkspace(store, workspaceId);
  const today = zonedParts(now.getTime(), zone).day;
  for (const block of calendarBlocksOf(store, workspaceId).filter((item) => item.day >= today).slice(0, 200)) {
    const location = (block as { location?: string }).location;
    if (location && location.length <= 60 && !/https?:\/\/|\d|@/.test(location)) await geocode({ city: location });
  }

  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const said = readJson<Record<string, string>>(store, workspaceId, CLASH_SAID_SETTING, {});
  let toldToday = Object.values(said).filter((at) => zonedParts(Date.parse(at), zone).day === today).length;
  let told = 0;
  for (const row of rows) {
    const ctx = feasibilityContextFor(store, workspaceId, { now, prepDays: prepDaysOf(store, workspaceId, row), locale,
      geocode, visa: async (citizenship, destination) => {
        const cached = freshVisa(readVisaCache(store.getSetting(workspaceId, VISA_CACHE_SETTING)), citizenship, destination, now);
        if (cached || visaBudget <= 0) return cached;
        visaBudget -= 1; visas += 1;
        return findVisa(store, workspaceId, citizenship, destination, deps);
      } });
    const verdict = await feasibilityOf(row, ctx);
    if (verdict.state !== "conflict") continue;
    // A movable work block is moved by the scheduler once the person registers; only a fixed arrangement is worth a message now.
    const fixed = verdict.clashes.filter((clash: CalendarClash) => clash.fixed);
    if (!fixed.length) continue;
    const fingerprint = `${row.id}:${fixed.map((clash) => `${clash.blockId}@${clash.start}`).sort().join(",")}`;
    if (said[fingerprint] || toldToday >= CLASH_MESSAGES_PER_DAY || !daytime(now, zone)) continue;
    sayToPerson(store, workspaceId, t("「{{title}}」{{clash}}。要去的话，可以在机会卡上同意调整这项固定安排，再选怎么调整。",
      { title: row.title.slice(0, 80), clash: fixed.map((clash) => clashSentence(clash, locale)).join(locale === "en" ? "; " : "；") }),
      CLASH_NUDGE_KIND, `opportunity-clash:${fingerprint}`, [{ label: t("去看机会"), href: "/approvals" }, { label: t("少问这类"), kind: "mute" }], now);
    said[fingerprint] = now.toISOString();
    toldToday += 1; told += 1;
  }
  if (told) {
    // Fingerprints older than ninety days are dropped: the opportunity is long past.
    const kept = Object.fromEntries(Object.entries(said).filter(([, at]) => now.getTime() - Date.parse(at) < 90 * 86_400_000));
    store.setSetting(workspaceId, CLASH_SAID_SETTING, JSON.stringify(kept));
  }
  return { judged: rows.length, told, geocoded, visas };
}
