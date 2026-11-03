/**
 * Where the person is on a day (docs/opportunity-agent.md §17.6, track ②), from four sources the person already has or chose: a device
 * position under its own consent, trips on their calendar, trips read from booking confirmations in their mail, and the confirmed home
 * fact. Pure: the worker reads the ledger and hands the pieces in; `feasibilityOf` picks one per day with `placeOn`.
 */
import type { PersonPlace } from "./opportunity-watch";

/**
 * Device location (§17.6, the person's decision of 2026-11-02): its own consent, off by default. A phone or browser posts its position;
 * only two decimals (about 1 km) and only the latest reading are kept, never a track; turning the consent off deletes the reading.
 */
export const DEVICE_LOCATION_CONSENT = "location.device.consent";
export const DEVICE_LOCATION_SETTING = "location.device";
export type DeviceLocation = { lat: number; lon: number; at: string; city?: string | undefined; country?: string | undefined };
/** Two decimals: about 1.1 km of latitude. */
export const roundCoord = (value: number): number => Math.round(value * 100) / 100;
export function deviceReading(lat: unknown, lon: unknown, at: string): DeviceLocation | undefined {
  const a = Number(lat), b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return undefined;
  return { lat: roundCoord(a), lon: roundCoord(b), at };
}
export function readDeviceLocation(raw: string | null | undefined): DeviceLocation | undefined {
  try {
    const value = JSON.parse(raw ?? "null") as DeviceLocation | null;
    return value && Number.isFinite(value.lat) && Number.isFinite(value.lon) && typeof value.at === "string" ? value : undefined;
  } catch { return undefined; }
}

/** Trips read from booking confirmations (mail kind `travel`), newest last; each with the mail's own quote. */
export const MAIL_TRIPS_SETTING = "travel.trips";
export const MAIL_TRIPS_KEEP = 40;
export function readMailTrips(raw: string | null | undefined): PersonPlace[] {
  try { const parsed = JSON.parse(raw ?? "[]") as PersonPlace[]; return Array.isArray(parsed) ? parsed.filter((item) => item?.source === "mail" && typeof item.city === "string") : []; }
  catch { return []; }
}

const squashText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/**
 * A trip the mail triage read from a booking confirmation, kept only when code finds its quote in the mail itself, the dates are real days
 * and the trip has not ended; the model sorts, it never places the person anywhere on its own word.
 */
export function mailTripPlace(trip: { city: string; country: string; from: string; to: string; quote: string } | undefined, mailText: string,
  today: string, ref: string): PersonPlace | undefined {
  if (!trip?.city.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(trip.from) || !/^\d{4}-\d{2}-\d{2}$/.test(trip.to) || trip.to < trip.from || trip.to < today) return undefined;
  if (Number.isNaN(Date.parse(`${trip.from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${trip.to}T00:00:00Z`))) return undefined;
  const quote = squashText(trip.quote);
  if (quote.length < 6 || !squashText(mailText).includes(quote)) return undefined;
  return { from: trip.from, to: trip.to, city: trip.city.trim().slice(0, 80), country: trip.country.trim().slice(0, 60), source: "mail", ref };
}
/** The kept trips with one more: same mail replaces, ended ones dropped, newest `MAIL_TRIPS_KEEP`. */
export function withMailTrip(trips: readonly PersonPlace[], trip: PersonPlace, today: string): PersonPlace[] {
  return [...trips.filter((item) => item.ref !== trip.ref && item.to >= today), trip].slice(-MAIL_TRIPS_KEEP);
}

type FactLike = { identityId: string; slot: string; value: string; status: string };
// i18n-ignore-start: fact slot names, never shown
const HOME_SLOTS = ["home_city", "city", "current_city", "location", "residence"];
const COUNTRY_SLOTS = ["country", "country_of_residence"];
const CITIZENSHIP_SLOTS = ["apply.citizenship", "citizenship", "nationality"];
const ASSUMED = /^假设[:：]/;
// i18n-ignore-end
const usable = (fact: FactLike) => fact.identityId === "person" && fact.status === "confirmed" && Boolean(fact.value.trim()) && !ASSUMED.test(fact.value.trim());
const firstOf = (facts: readonly FactLike[], slots: string[]) => {
  for (const slot of slots) { const fact = facts.find((item) => usable(item) && item.slot === slot); if (fact) return fact; }
  return undefined;
};

/** The confirmed home city (and country), the default place for every day; undefined when the person has not said. */
export function homePlace(facts: readonly FactLike[]): PersonPlace | undefined {
  const city = firstOf(facts, HOME_SLOTS);
  if (!city) return undefined;
  const country = firstOf(facts, COUNTRY_SLOTS);
  return { from: "0000-01-01", to: "9999-12-31", city: city.value.trim().slice(0, 80), country: country?.value.trim().slice(0, 60) ?? "", source: "fact", ref: `person//${city.slot}` };
}
/** The confirmed citizenship, for the visa check; never an assumption. */
export const citizenshipOf = (facts: readonly FactLike[]): string | undefined => firstOf(facts, CITIZENSHIP_SLOTS)?.value.trim().slice(0, 60);

/** A device reading covers only the local day it was taken on. */
export function devicePlace(reading: DeviceLocation | undefined, day: string): PersonPlace | undefined {
  return reading ? { from: day, to: day, city: reading.city ?? "", country: reading.country ?? "", lat: reading.lat, lon: reading.lon, source: "device", ref: "device" } : undefined;
}

type BlockLike = { id: string; title: string; day?: string | undefined; location?: string | undefined };
// i18n-ignore-start: words read from calendar titles, never shown
const FLIGHT = /\b(flight|fly|flying)\b|航班|飞往|飞机|✈/i;
const DESTINATION = [/\bto\s+([A-Z][\p{L} .'-]{1,40}?)(?=\s*(?:\(|,|\bon\b|\bvia\b|$|[-–]))/u, /飞往\s*([\p{L}]{2,20})/u, /前往\s*([\p{L}]{2,20})/u, /去\s*([\p{L}]{2,10})(?:出差|开会|旅行)/u];
const TRIP = /\b(trip|travel|conference)\s+to\b|出差|旅行/i;
// i18n-ignore-end
const addDay = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Trips on the calendar (§17.6 b): a flight or a 「trip to / 出差 / 旅行」 event names where the person goes from that day on, until their
 * next flight (a return or the next leg); with none after it, three days are assumed. The city is a name for the geocoder, not a fact.
 */
export function tripsFromBlocks(blocks: readonly BlockLike[], homeCity?: string): PersonPlace[] {
  const dated = blocks.filter((block) => block.day && (FLIGHT.test(block.title) || TRIP.test(block.title)))
    .sort((a, b) => a.day!.localeCompare(b.day!));
  const out: PersonPlace[] = [];
  dated.forEach((block, index) => {
    const city = DESTINATION.map((pattern) => pattern.exec(block.title)?.[1]?.trim()).find(Boolean);
    if (!city || (homeCity && city.toLowerCase() === homeCity.trim().toLowerCase())) return;
    const next = dated.slice(index + 1).find((item) => FLIGHT.test(item.title) && item.day! > block.day!);
    const to = next ? addDay(next.day!, -1) : addDay(block.day!, 3);
    out.push({ from: block.day!, to: to < block.day! ? block.day! : to, city: city.slice(0, 60), country: "", source: "calendar", ref: block.id });
  });
  return out;
}

/** A calendar event at a named place on one day (§17.6 b), when the location reads as a place name rather than a street address or a link. */
export const placeNameOf = (location: string | undefined): string | undefined => {
  const text = (location ?? "").trim();
  if (!text || text.length > 60 || /https?:\/\/|\d|@/.test(text)) return undefined;
  return text;
};

/** Every place known, in no order; `placeOn` picks per day. */
export function personPlaces(input: { facts: readonly FactLike[]; device?: DeviceLocation | undefined; deviceDay?: string | undefined;
  calendar: readonly PersonPlace[]; mail: readonly PersonPlace[] }): PersonPlace[] {
  const home = homePlace(input.facts);
  const device = input.deviceDay ? devicePlace(input.device, input.deviceDay) : undefined;
  return [...(home ? [home] : []), ...(device ? [device] : []), ...input.calendar, ...input.mail];
}

/**
 * The geocoder's ledger cache (`geo.cache`), shared by the worker (which asks Nominatim and fills it) and the web (which reads it while a
 * page renders and never waits on the network). A miss is kept for a month; a city found is kept for good.
 */
export const GEO_CACHE_SETTING = "geo.cache";
export const GEO_MISS_DAYS = 30;
export type GeoCacheEntry = { lat: number; lon: number; city: string; country: string; at: string } | { miss: true; at: string };
export const geoCacheKey = (query: { city: string; country?: string | undefined; venue?: string | undefined }) =>
  `s:${[query.venue ?? "", query.city, query.country ?? ""].map((part) => part.trim().toLowerCase()).join("|")}`;
export function readGeoCache(raw: string | null | undefined): Record<string, GeoCacheEntry> {
  try { const parsed = JSON.parse(raw ?? "{}") as Record<string, GeoCacheEntry>; return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}
/** A cached point, `"miss"` for a recent miss, undefined when never asked (or the miss is old). */
export function cachedGeoPoint(entry: GeoCacheEntry | undefined, now: Date): { lat: number; lon: number; city: string; country: string } | "miss" | undefined {
  if (!entry) return undefined;
  if ("miss" in entry) return now.getTime() - Date.parse(entry.at) < GEO_MISS_DAYS * 86_400_000 ? "miss" : undefined;
  return { lat: entry.lat, lon: entry.lon, city: entry.city, country: entry.country };
}
