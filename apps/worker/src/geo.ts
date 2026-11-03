import { GEO_CACHE_SETTING, cachedGeoPoint, geoCacheKey, readGeoCache, type GeoCacheEntry, type GeoPoint, type GeoQuery } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { defaultSafeGetDeps, safeGet, type SafeGetDeps } from "./safe-fetch";

/**
 * Geocoding for the time–space engine (docs/opportunity-agent.md §17.6, track ②): OpenStreetMap's Nominatim, no key. Its usage policy is
 * kept in code: at most one request a second across the whole worker, an identifying User-Agent, every answer cached in the ledger (a miss
 * too, for a month), and queries for a city or a venue only — never a street address or a person's coordinates beyond the ~1 km a device
 * reading is already rounded to. A new outbound read path from the worker (the web's map estimate already used the same host).
 */
export const NOMINATIM_HOST = "nominatim.openstreetmap.org";
export const NOMINATIM_USER_AGENT = "Crossline/1.0 (personal planner; opportunity time-space check; https://github.com/KarolYan1215/crossline)";
const GAP_MS = 1_100;
const CACHE_KEEP = 2_000;

/** A street address (a house number before or after a street word, 「12 号」) or a link is not something this geocoder is asked about. */
// i18n-ignore-start: address words matched in queries, never shown
const STREET = /\b\d{1,5}\s+[\p{L}.' -]{2,40}\s(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy)\b|\d+\s*号|https?:\/\/|@/iu;
// i18n-ignore-end
export const geoQueryAllowed = (query: GeoQuery): boolean => {
  const city = query.city.trim(), venue = query.venue?.trim() ?? "";
  return Boolean(city) && city.length <= 80 && venue.length <= 120 && !STREET.test(city) && !STREET.test(venue) && !/\d{3,}/.test(city);
};

/** One slot per `GAP_MS` for the whole process, however many workspaces ask. */
let nextSlot = 0;
async function paced(sleep: (ms: number) => Promise<void>, now: () => number): Promise<void> {
  const at = Math.max(now(), nextSlot);
  nextSlot = at + GAP_MS;
  if (at > now()) await sleep(at - now());
}
export const resetGeoPacing = () => { nextSlot = 0; };

export type GeoDeps = { http?: SafeGetDeps; sleep?: (ms: number) => Promise<void>; now?: () => Date };
export type Geocoder = { geocode: (query: GeoQuery) => Promise<GeoPoint | undefined>; reverse: (lat: number, lon: number) => Promise<GeoPoint | undefined>;
  /** Cached answers only, no request: for a pass that must not wait on the network. */
  cached: (query: GeoQuery) => GeoPoint | undefined };

const readCache = (store: CrosslineStore, workspaceId: string) => readGeoCache(store.getSetting(workspaceId, GEO_CACHE_SETTING));

export function geocoderFor(store: CrosslineStore, workspaceId: string, deps: GeoDeps = {}): Geocoder {
  const http = deps.http ?? defaultSafeGetDeps();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = () => (deps.now?.() ?? new Date()).getTime();
  const fromEntry = (entry: GeoCacheEntry | undefined): GeoPoint | undefined | "miss" => cachedGeoPoint(entry, new Date(now()));
  const save = (key: string, entry: GeoCacheEntry) => {
    const cache = readCache(store, workspaceId);
    cache[key] = entry;
    const keys = Object.keys(cache);
    for (const old of keys.slice(0, Math.max(0, keys.length - CACHE_KEEP))) delete cache[old];
    store.setSetting(workspaceId, GEO_CACHE_SETTING, JSON.stringify(cache));
  };
  const ask = async (key: string, url: string): Promise<GeoPoint | undefined> => {
    const hit = fromEntry(readCache(store, workspaceId)[key]);
    if (hit === "miss") return undefined;
    if (hit) return hit;
    await paced(sleep, now);
    const response = await safeGet(url, http, { maxBytes: 200_000, timeoutMs: 10_000, types: ["application/json"], userAgent: NOMINATIM_USER_AGENT });
    // A service that does not answer is not a place that does not exist: nothing is cached, the next pass asks again.
    if (!response.ok) return undefined;
    let rows: unknown;
    try { rows = JSON.parse(new TextDecoder().decode(response.bytes)); } catch { return undefined; }
    const row = (Array.isArray(rows) ? rows[0] : rows) as { lat?: string; lon?: string; address?: Record<string, string>; error?: string } | undefined;
    const lat = Number(row?.lat), lon = Number(row?.lon);
    const at = new Date(now()).toISOString();
    if (!row || row.error || !Number.isFinite(lat) || !Number.isFinite(lon)) { save(key, { miss: true, at }); return undefined; }
    const address = row.address ?? {};
    const entry = { lat, lon, city: address.city ?? address.town ?? address.village ?? address.municipality ?? address.county ?? address.state ?? "",
      country: address.country ?? "", at };
    save(key, entry);
    return { lat, lon, city: entry.city, country: entry.country };
  };
  const base = `https://${NOMINATIM_HOST}`;
  const params = "format=jsonv2&limit=1&addressdetails=1&accept-language=en";
  return {
    geocode: async (query) => {
      if (!geoQueryAllowed(query)) return undefined;
      const url = query.venue?.trim()
        ? `${base}/search?${params}&q=${encodeURIComponent([query.venue, query.city, query.country].filter((part) => part?.trim()).join(", "))}`
        : `${base}/search?${params}&city=${encodeURIComponent(query.city.trim())}${query.country?.trim() ? `&country=${encodeURIComponent(query.country.trim())}` : ""}`;
      return ask(geoCacheKey(query), url);
    },
    // City level (zoom 10) from a position already rounded to two decimals: the answer names a town, never a street.
    reverse: async (lat, lon) => {
      const a = Math.round(lat * 100) / 100, b = Math.round(lon * 100) / 100;
      return ask(`r:${a},${b}`, `${base}/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=en&lat=${a}&lon=${b}`);
    },
    cached: (query) => { const hit = fromEntry(readCache(store, workspaceId)[geoCacheKey(query)]); return hit === "miss" ? undefined : hit; }
  };
}
