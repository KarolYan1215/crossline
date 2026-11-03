import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, DEVICE_LOCATION_CONSENT, DEVICE_LOCATION_SETTING, GEO_CACHE_SETTING, MAIL_TRIPS_SETTING,
  VISA_CACHE_SETTING, cachedGeoPoint, citizenshipOf, freshVisa, geoCacheKey, haversineKm, homePlace, personPlaces, placeNameOf, readDeviceLocation,
  readGeoCache, readMailTrips, readVisaCache, resolveAvailability, tripsFromBlocks, zonedParts,
  type FeasibilityBlock, type FeasibilityContext, type GeoPoint, type GeoQuery, type Locale, type PersonPlace, type SyncFeasibilityContext, type VisaCheck
} from "@crossline/core";
import type { CrosslineStore } from "./index";
import { readWatchList } from "./opportunity-watches";

/**
 * The time–space engine's reading of the ledger (docs/opportunity-agent.md §17.6, track ②), shared by the worker (which fills the geocode
 * and visa caches and tells the person about a clash) and the web (which judges each offer card on read, with the plan's work blocks).
 * Nothing here asks the network: lookups come from the caches the worker keeps.
 */

export const zoneOfWorkspace = (store: CrosslineStore, workspaceId: string): string => {
  try { return (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone
    || process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago"; }
  catch { return "America/Chicago"; }
};

type PlanBlock = { id: string; title?: string; day?: string; start?: string; end?: string; location?: string };
/** The current plan's dated calendar blocks (synced calendars, imported files): what the worker knows of the person's fixed time. */
export function calendarBlocksOf(store: CrosslineStore, workspaceId: string): FeasibilityBlock[] {
  const blocks = ((store.listPlanVersions(workspaceId)[0]?.payload as { blocks?: PlanBlock[] } | undefined)?.blocks) ?? [];
  return blocks.filter((block) => block.day && block.start && block.end).map((block) => ({ id: block.id, title: block.title ?? "", day: block.day!,
    start: block.start!, end: block.end!, ...(block.location ? { location: block.location } : {}) }));
}

/** The plan's derived blocks of the coming weeks (work, added events), written by the web's attention timer: the worker cannot derive them. */
export const WORK_BLOCKS_SETTING = "schedule.workBlocks";
/** Calendar blocks plus the plan's own: everything a clash is judged against (§17.7), each read as fixed or movable from its id. */
export function planBlocksOf(store: CrosslineStore, workspaceId: string): FeasibilityBlock[] {
  let work: FeasibilityBlock[] = [];
  try { const parsed = JSON.parse(store.getSetting(workspaceId, WORK_BLOCKS_SETTING) ?? "[]") as FeasibilityBlock[]; if (Array.isArray(parsed)) work = parsed; } catch { /* none yet */ }
  const calendar = calendarBlocksOf(store, workspaceId);
  const ids = new Set(calendar.map((block) => block.id));
  return [...calendar, ...work.filter((block) => block && typeof block.day === "string" && !ids.has(block.id))];
}

export const deviceLocationOn = (store: CrosslineStore, workspaceId: string) => store.getSetting(workspaceId, DEVICE_LOCATION_CONSENT) === "on";

/** Cached lookups only: what the worker has already asked Nominatim and the visa pages. */
export function cachedGeocoder(store: CrosslineStore, workspaceId: string, now: Date): (query: GeoQuery) => GeoPoint | undefined {
  const cache = readGeoCache(store.getSetting(workspaceId, GEO_CACHE_SETTING));
  return (query) => { const hit = cachedGeoPoint(cache[geoCacheKey(query)], now); return hit === "miss" ? undefined : hit; };
}
export function cachedVisas(store: CrosslineStore, workspaceId: string, now: Date): (citizenship: string, destination: string) => VisaCheck | undefined {
  const cache = readVisaCache(store.getSetting(workspaceId, VISA_CACHE_SETTING));
  return (citizenship, destination) => freshVisa(cache, citizenship, destination, now);
}

/** Calendar events at a named place more than this far from home put the person there for that day (§17.6 b). */
const AWAY_KM = 100;

/**
 * Where the person is, from the four sources (§17.6): the device reading (only while its consent is on), the calendar's trips and events
 * at a named place far from home (found through the geocode cache), mail trips, and the home fact.
 */
export function personPlacesFor(store: CrosslineStore, workspaceId: string, now: Date,
  geocode: (query: GeoQuery) => GeoPoint | undefined = cachedGeocoder(store, workspaceId, now)): PersonPlace[] {
  const zone = zoneOfWorkspace(store, workspaceId);
  const today = zonedParts(now, zone).day;
  const facts = store.listProfileFacts(workspaceId);
  const home = homePlace(facts);
  const device = deviceLocationOn(store, workspaceId) ? readDeviceLocation(store.getSetting(workspaceId, DEVICE_LOCATION_SETTING)) : undefined;
  const blocks = calendarBlocksOf(store, workspaceId).filter((block) => block.day >= today) as Array<FeasibilityBlock & { location?: string }>;
  const homePoint = home ? geocode({ city: home.city, ...(home.country ? { country: home.country } : {}) }) : undefined;
  const away: PersonPlace[] = [];
  for (const block of blocks) {
    const name = placeNameOf(block.location);
    const point = name ? geocode({ city: name }) : undefined;
    if (!name || !point || !homePoint || haversineKm(point, homePoint) < AWAY_KM) continue;
    away.push({ from: block.day, to: block.day, city: point.city || name, country: point.country ?? "", lat: point.lat, lon: point.lon, source: "calendar", ref: block.id });
  }
  return personPlaces({ facts, device, deviceDay: device ? zonedParts(Date.parse(device.at), zone).day : undefined,
    calendar: [...tripsFromBlocks(blocks, home?.city), ...away], mail: readMailTrips(store.getSetting(workspaceId, MAIL_TRIPS_SETTING)) });
}

/** Everything `feasibilityOf` needs from the ledger, with cached lookups; callers add the blocks they know of and the preparation days. */
export function feasibilityContextFor(store: CrosslineStore, workspaceId: string, input: { now: Date; prepDays: number;
  blocks?: FeasibilityBlock[]; geocode?: FeasibilityContext["geocode"]; visa?: FeasibilityContext["visa"]; localMinutesMax?: number; locale?: Locale }): FeasibilityContext {
  const base = cachedFeasibilityContext(store, workspaceId, input);
  return { ...base, ...(input.geocode ? { geocode: input.geocode } : {}), ...(input.visa ? { visa: input.visa } : {}) };
}

/** The same from the caches alone, for `feasibilityNow`: what a page can judge while it renders, without waiting on the network. */
export function cachedFeasibilityContext(store: CrosslineStore, workspaceId: string, input: { now: Date; prepDays: number;
  blocks?: FeasibilityBlock[]; localMinutesMax?: number; locale?: Locale }): SyncFeasibilityContext {
  const facts = store.listProfileFacts(workspaceId);
  const citizenship = citizenshipOf(facts);
  const { windows } = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts });
  return {
    now: input.now, timeZone: zoneOfWorkspace(store, workspaceId), prepDays: input.prepDays,
    places: personPlacesFor(store, workspaceId, input.now), geocode: cachedGeocoder(store, workspaceId, input.now),
    ...(citizenship ? { citizenship } : {}), visa: cachedVisas(store, workspaceId, input.now),
    blocks: input.blocks ?? planBlocksOf(store, workspaceId), availability: windows,
    ...(input.localMinutesMax ? { localMinutesMax: input.localMinutesMax } : {}), ...(input.locale ? { locale: input.locale } : {})
  };
}

/** The preparation an opportunity needs before its deadline: its watch's lead time, else none (an event one turns up to). */
export const prepDaysOf = (store: CrosslineStore, workspaceId: string, row: { needId?: string | undefined; kind?: string | undefined }): number =>
  row.kind === "event" ? 0 : (row.needId ? readWatchList(store, workspaceId).find((watch) => watch.id === row.needId)?.leadDays : undefined) ?? 0;
