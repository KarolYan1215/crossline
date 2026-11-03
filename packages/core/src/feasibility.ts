/**
 * The time–space engine (docs/opportunity-agent.md §17.6–17.7, track ②): whether the person can take an opportunity up, worked out in
 * code before anything reaches them. Models are weakest exactly here — durations, counting back across months, distances (Test of Time,
 * GPSBench) — so the model only reads the page; this file does the arithmetic. Pure: every outside lookup (geocoder, the person's places,
 * the calendar, availability, the visa cache, the zone) comes in through `FeasibilityContext`, so the synthetic world (track ③) drives it
 * with fakes and the watches (track ①) call it before surfacing anything.
 *
 * Stable signature: `feasibilityOf(opportunity: Opportunity, ctx: FeasibilityContext): Promise<Feasibility>`.
 */
import { availableSlots, type AvailabilityWindow } from "./availability";
import { tFor, type Locale } from "./i18n";
import type { DatedQuote, Opportunity } from "./opportunity";
import {
  LOCAL_MINUTES_MAX, VISA_LEAD_FALLBACK_DAYS, type CalendarClash, type EventPlace, type Feasibility, type InfeasibleCode,
  type OpportunityCategory, type PersonPlace, type TravelCostTier, type TravelEstimate, type VisaCheck
} from "./opportunity-watch";

export type GeoPoint = { lat: number; lon: number; city?: string | undefined; country?: string | undefined };
/** What the geocoder is asked: a city (and country), or a venue in a city. Never a street address or a person (§17.6, OSM policy). */
export type GeoQuery = { city: string; country?: string | undefined; venue?: string | undefined };
type Maybe<T> = T | undefined | Promise<T | undefined>;

/** A block on the person's calendar or plan, on their local clock (`day` `YYYY-MM-DD`, `start`/`end` `HH:MM`), as the plan keeps it. */
export type FeasibilityBlock = { id: string; title: string; day: string; start: string; end: string;
  /** Set when the caller knows; otherwise read from the id (`blockIsFixed`). */
  fixed?: boolean | undefined };

export type FeasibilityContext = {
  now: Date;
  /** The person's IANA zone: "today" and every local day are read in it, never in UTC (§17.5). */
  timeZone: string;
  /** Days of preparation the deadline needs (a watch's or need's lead); 0 for an event one just turns up to. */
  prepDays: number;
  /** Everything known about where the person is (`PersonPlace`, any source); `placeOn` picks the one for a day. */
  places: readonly PersonPlace[];
  geocode: (query: GeoQuery) => Maybe<GeoPoint>;
  /** The person's confirmed citizenship (a country name or code), when there is one. */
  citizenship?: string | undefined;
  /** The cached official reading for this citizenship and destination; undefined when none could be read (fallback, unverified). */
  visa: (citizenship: string, destination: string) => Maybe<VisaCheck>;
  blocks: readonly FeasibilityBlock[];
  /** The weekly availability pattern (`resolveAvailability`); empty means unknown and never makes anything infeasible. */
  availability: readonly AvailabilityWindow[];
  /** The local-event radius in minutes, tightened by 「太远」 (§17.4); `LOCAL_MINUTES_MAX` by default. */
  localMinutesMax?: number | undefined;
  /** The language the reasons' details are written in. */
  locale?: Locale | undefined;
};

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const addDay = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** The local day and clock of an instant in a zone. */
export function zonedParts(at: Date | number, timeZone: string): { day: string; clock: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}` };
}
/** The zone's offset from UTC in minutes at an instant (Chicago in winter: −360). */
export function zoneOffsetMinutes(timeZone: string, at: number): number {
  const { day, clock } = zonedParts(at, timeZone);
  const asUtc = Date.parse(`${day}T${clock}:00Z`);
  return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}
/** The instant a local wall-clock time in a zone names (the offset found twice, so a DST change on that day still lands right). */
export function instantInZone(day: string, clock: string, timeZone: string): number {
  const guess = Date.parse(`${day}T${clock}:00Z`);
  const first = guess - zoneOffsetMinutes(timeZone, guess) * 60_000;
  return guess - zoneOffsetMinutes(timeZone, first) * 60_000;
}

/**
 * Zone words a deadline is written with, as minutes from UTC. `CST` is US Central unless the quote is Chinese or says China (then UTC+8);
 * an explicit `UTC+8` / `GMT-5` always wins.
 */
// i18n-ignore-start: zone words read from pages, never shown
const ZONE_WORDS: Record<string, number> = {
  AOE: -720, "ANYWHERE ON EARTH": -720, UTC: 0, GMT: 0, Z: 0, WET: 0, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  IST: 330, SGT: 480, HKT: 480, AWST: 480, JST: 540, KST: 540, ACST: 570, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
  HST: -600, AKST: -540, AKDT: -480, PST: -480, PDT: -420, PT: -480, MST: -420, MDT: -360, CST: -360, CDT: -300, CT: -360, EST: -300, EDT: -240,
  ET: -300, "北京时间": 480
};
const CHINESE = /[一-鿿]|china|beijing|中国/i;
// i18n-ignore-end
/** A deadline's zone from its quote, in minutes from UTC; undefined when the quote names none (the person's zone is taken then). */
export function quotedZoneOffset(quote: string): number | undefined {
  const explicit = /\b(?:UTC|GMT)\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(quote);
  if (explicit) return (explicit[1] === "+" ? 1 : -1) * (Number(explicit[2]) * 60 + Number(explicit[3] ?? 0));
  if (/北京时间/.test(quote)) return 480;
  if (/anywhere on earth|\bAoE\b/i.test(quote)) return -720;
  const words = quote.toUpperCase().match(/\b[A-Z]{1,5}\b/g) ?? [];
  for (const word of words) {
    if (!(word in ZONE_WORDS) || word === "Z") continue;
    // Bare 「ET」/「PT」/「CT」 are words in other languages too; counted only when they follow a time.
    if (["ET", "PT", "CT"].includes(word) && !new RegExp(`\\d\\s*(?:[AP]\\.?M\\.?)?\\s*${word}\\b`, "i").test(quote)) continue;
    if (word === "CST" && CHINESE.test(quote)) return 480;
    return ZONE_WORDS[word];
  }
  return undefined;
}
/** The clock a quote names (`11:59 PM`, `23:59`, `noon`, `midnight`); undefined when none. 「midnight」 is the end of the named day. */
export function quotedClock(quote: string): string | undefined {
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?![a-z])/i.exec(quote);
  if (ampm) {
    const hour = Number(ampm[1]) % 12 + (ampm[3]!.toLowerCase() === "p" ? 12 : 0);
    return `${String(hour).padStart(2, "0")}:${ampm[2] ?? "00"}`;
  }
  const h24 = /(?<![\d:])([01]?\d|2[0-3])[:：]([0-5]\d)(?![\d])/.exec(quote);
  if (h24) return `${h24[1]!.padStart(2, "0")}:${h24[2]}`;
  if (/\bnoon\b|中午/i.test(quote)) return "12:00";
  if (/\bmidnight\b|午夜|24:00/i.test(quote)) return "23:59";
  return undefined;
}

/**
 * The instant a dated quote stands for: its day at the quote's clock (else the end of the day) in the quote's zone (else the person's).
 * A deadline 「Nov 15, 11:59 PM AoE」 is still open on the morning of the 16th in Chicago; one in CET has closed by then.
 */
export function quotedInstant(item: DatedQuote, personZone: string, endOfDay = true): number | undefined {
  if (!DAY.test(item.day)) return undefined;
  const clock = quotedClock(item.quote) ?? (endOfDay ? "23:59" : "00:00");
  const offset = quotedZoneOffset(item.quote);
  if (offset === undefined) return instantInZone(item.day, clock, personZone);
  return Date.parse(`${item.day}T${clock}:00Z`) - offset * 60_000;
}

/** A start and end clock written as a range in a quote (「7:00 PM – 9:00 PM」, 「19:00-21:00」), when there is one. */
export function quotedRange(quote: string): { start: string; end: string } | undefined {
  const match = /(\d{1,2}(?:[:：]\d{2})?\s*(?:[ap]\.?\s*m\.?)?)\s*(?:[-–—~～至到]|to)\s*(\d{1,2}(?:[:：]\d{2})?\s*(?:[ap]\.?\s*m\.?)?)/i.exec(quote);
  if (!match) return undefined;
  const endClock = quotedClock(match[2]!.includes(":") || /m/i.test(match[2]!) ? match[2]! : `${match[2]}:00`);
  const startText = /[ap]\.?\s*m/i.test(match[1]!) || !/[ap]\.?\s*m/i.test(match[2]!) ? match[1]! : `${match[1]} ${/p/i.test(match[2]!) ? "pm" : "am"}`;
  const startClock = quotedClock(startText.includes(":") || /m/i.test(startText) ? startText : `${startText}:00`);
  return startClock && endClock && startClock < endClock ? { start: startClock, end: endClock } : undefined;
}

// ── Where ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const RANK: Record<PersonPlace["source"], number> = { device: 0, calendar: 1, mail: 2, fact: 3 };
/**
 * Where the person is on a local day (§17.6): among the places whose range covers it, device first, then calendar, then mail, then the
 * home fact. A device reading covers only the day it was taken, so a trip on the calendar wins for any later day.
 */
export function placeOn(day: string, places: readonly PersonPlace[]): PersonPlace | undefined {
  return places.filter((place) => place.from.slice(0, 10) <= day && day <= place.to.slice(0, 10))
    .sort((a, b) => RANK[a.source] - RANK[b.source] || b.from.localeCompare(a.from))[0];
}

// i18n-ignore-start: country names read from pages and facts, never shown
const COUNTRY_ALIASES: Record<string, string> = {
  us: "us", usa: "us", "u.s.": "us", "u.s.a.": "us", "united states": "us", "united states of america": "us", america: "us", 美国: "us",
  cn: "cn", china: "cn", prc: "cn", "people's republic of china": "cn", "mainland china": "cn", 中国: "cn", 中国大陆: "cn", 中华人民共和国: "cn",
  gb: "gb", uk: "gb", "united kingdom": "gb", "great britain": "gb", britain: "gb", england: "gb", 英国: "gb",
  ca: "ca", canada: "ca", 加拿大: "ca", de: "de", germany: "de", deutschland: "de", 德国: "de", fr: "fr", france: "fr", 法国: "fr",
  jp: "jp", japan: "jp", 日本: "jp", kr: "kr", korea: "kr", "south korea": "kr", "republic of korea": "kr", 韩国: "kr",
  sg: "sg", singapore: "sg", 新加坡: "sg", au: "au", australia: "au", 澳大利亚: "au", hk: "hk", "hong kong": "hk", 香港: "hk", 中国香港: "hk",
  tw: "tw", taiwan: "tw", 台湾: "tw", 中国台湾: "tw", mo: "mo", macau: "mo", macao: "mo", 澳门: "mo",
  in: "in", india: "in", 印度: "in", nl: "nl", netherlands: "nl", 荷兰: "nl", ch: "ch", switzerland: "ch", 瑞士: "ch",
  it: "it", italy: "it", 意大利: "it", es: "es", spain: "es", 西班牙: "es", se: "se", sweden: "se", 瑞典: "se", at: "at", austria: "at", 奥地利: "at",
  be: "be", belgium: "be", 比利时: "be", ie: "ie", ireland: "ie", 爱尔兰: "ie", nz: "nz", "new zealand": "nz", 新西兰: "nz",
  mx: "mx", mexico: "mx", 墨西哥: "mx", br: "br", brazil: "br", 巴西: "br", ae: "ae", "united arab emirates": "ae", uae: "ae", 阿联酋: "ae",
  il: "il", israel: "il", 以色列: "il", th: "th", thailand: "th", 泰国: "th", vn: "vn", vietnam: "vn", 越南: "vn", my: "my", malaysia: "my", 马来西亚: "my"
};
// i18n-ignore-end
/** One key per country however it is written (「美国」, 「USA」, 「United States」 → `us`); an unknown name keys as itself, normalised. */
export const countryKey = (name: string | undefined): string => {
  const plain = (name ?? "").trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ");
  return COUNTRY_ALIASES[plain] ?? plain;
};

/** Great-circle distance in km (haversine, mean Earth radius). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The rule table of §17.6. Detour factors and speeds are stated assumptions, not a router: the point is the order of magnitude. */
export const TRAVEL_RULES = {
  walkKm: 2, localKm: 40, railKm: 600,
  detour: 1.4, walkKmh: 5, cityKmh: 25, railKmh: 100, railAccessMinutes: 30, flightKmh: 750, airportMinutes: 180
} as const;
/**
 * Mode and one-way time from the straight-line distance (§17.6), then nights and travel days: arriving the evening before once a trip is
 * over two hours, staying the night after once it is over four, plus the event's own extra days.
 */
export function travelEstimate(km: number, eventDays = 1): TravelEstimate {
  const r = TRAVEL_RULES;
  const [mode, minutes]: [TravelEstimate["mode"], number] =
    km <= r.walkKm ? ["walk", (km * r.detour) / r.walkKmh * 60]
      : km <= r.localKm ? ["transit", (km * r.detour) / r.cityKmh * 60]
        : km <= r.railKm ? ["rail", (km * r.detour) / r.railKmh * 60 + r.railAccessMinutes]
          : ["flight", km / r.flightKmh * 60 + r.airportMinutes];
  const minutesOneWay = Math.max(1, Math.round(minutes));
  const before = minutesOneWay > 120 ? 1 : 0;
  const after = minutesOneWay > 240 ? 1 : 0;
  const nights = Math.max(0, eventDays - 1) + before + after;
  const costTier: TravelCostTier = mode === "flight" || nights >= 2 ? "high" : mode === "rail" || nights === 1 ? "medium" : "low";
  return { km: Math.round(km * 10) / 10, mode, minutesOneWay, nights, travelDays: before, costTier };
}

// i18n-ignore-start: words read from titles, never shown
const FAR_WORDS = /conference|symposium|congress|summit|workshop|hackathon|competition|challenge|olympiad|contest|fellowship|internship|intern\b|residency|summer school|大会|会议|研讨会|峰会|比赛|竞赛|大赛|挑战赛|黑客松|实习|奖学金|暑期学校/i;
// i18n-ignore-end
/** The category an opportunity is held to: its own, else an application or a conference-like title is not local, else a local event. */
export function opportunityCategory(opportunity: Pick<Opportunity, "kind" | "title"> & { category?: OpportunityCategory | undefined }): OpportunityCategory {
  if (opportunity.category) return opportunity.category;
  if (opportunity.kind === "application") return /intern|实习/i.test(opportunity.title) ? "internship" : "program";
  return FAR_WORDS.test(opportunity.title) ? (/hackathon|competition|challenge|contest|比赛|竞赛|大赛|黑客松/i.test(opportunity.title) ? "competition" : "conference") : "local_event";
}

// ── When ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Calendar items the plan owns can be moved by the scheduler; anything from a calendar, a file or the person's own events is fixed. */
export const blockIsFixed = (block: Pick<FeasibilityBlock, "id" | "fixed">): boolean =>
  block.fixed ?? !/^(scheduled|proposed|optional):/.test(block.id);

const toMinutes = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) => toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
const clockOf = (minutes: number) => `${String(Math.floor(Math.max(0, Math.min(1439, minutes)) / 60)).padStart(2, "0")}:${String(Math.max(0, Math.min(1439, minutes)) % 60).padStart(2, "0")}`;

/**
 * The blocks an event clashes with (§17.7): with a time on its start quote, the blocks overlapping it with the trip there and back added;
 * without one, every block on the day, and on the travel day before when there is one.
 */
export function eventClashes(input: { day: string; range?: { start: string; end: string } | undefined; travelMinutes: number; travelDays: number },
  blocks: readonly FeasibilityBlock[]): CalendarClash[] {
  const out: CalendarClash[] = [];
  const window = input.range ? { start: clockOf(toMinutes(input.range.start) - input.travelMinutes), end: clockOf(toMinutes(input.range.end) + input.travelMinutes) } : undefined;
  const days = new Set([input.day, ...Array.from({ length: input.travelDays }, (_, index) => addDay(input.day, -(index + 1)))]);
  for (const block of blocks) {
    if (!days.has(block.day)) continue;
    if (window && block.day === input.day && !overlaps(window, block)) continue;
    // On a travel day only what the journey itself would cover counts: with no clock for the event, the evening before.
    if (block.day !== input.day && toMinutes(block.end) <= 17 * 60) continue;
    out.push({ blockId: block.id, title: block.title, start: `${block.day}T${block.start}`, end: `${block.day}T${block.end}`, fixed: blockIsFixed(block) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Whether the weekly pattern has any usable time on a day (§17.6 `no_free_time`); an empty pattern is unknown, never "none". */
export const freeOnDay = (day: string, availability: readonly AvailabilityWindow[]): boolean =>
  availability.length === 0 || availableSlots([...availability], [day], []).some((slot) => weekdayOf(slot.day) === weekdayOf(day));

// ── The verdict ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Days from `from` to `to` (both `YYYY-MM-DD`), negative when `to` is earlier. */
export const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);

type Reason = { code: InfeasibleCode; detail: string };

/** The same context with lookups answered at once (the web's cached ones): `feasibilityNow` reads only this. */
export type SyncFeasibilityContext = Omit<FeasibilityContext, "geocode" | "visa"> & {
  geocode: (query: GeoQuery) => GeoPoint | undefined;
  visa: (citizenship: string, destination: string) => VisaCheck | undefined;
};

function pointOf(place: { city?: string | undefined; country?: string | undefined; lat?: number | undefined; lon?: number | undefined },
  geocode: SyncFeasibilityContext["geocode"]): GeoPoint | undefined {
  if (typeof place.lat === "number" && typeof place.lon === "number") return { lat: place.lat, lon: place.lon, city: place.city, country: place.country };
  if (!place.city?.trim()) return undefined;
  const point = geocode({ city: place.city.trim(), ...(place.country ? { country: place.country } : {}) });
  return point ? { ...point, city: point.city ?? place.city, country: point.country ?? place.country } : undefined;
}

/**
 * The verdict with lookups that may take time (the worker asks Nominatim and the visa pages): `feasibilityNow` is run, every lookup it
 * asked for and did not have is awaited, and it is run again with the answers, until nothing new is asked (at most four rounds). The
 * result is exactly `feasibilityNow`'s with every lookup answered.
 */
export async function feasibilityOf(opportunity: Opportunity, ctx: FeasibilityContext): Promise<Feasibility> {
  const places = new Map<string, GeoPoint | undefined>(), visas = new Map<string, VisaCheck | undefined>();
  let verdict: Feasibility | undefined;
  for (let round = 0; round < 4; round += 1) {
    const pending: Array<Promise<void>> = [];
    verdict = feasibilityNow(opportunity, { ...ctx,
      geocode: (query) => {
        const key = JSON.stringify([query.city, query.country ?? "", query.venue ?? ""]);
        if (!places.has(key)) { places.set(key, undefined); pending.push(Promise.resolve(ctx.geocode(query)).then((point) => { places.set(key, point); })); }
        return places.get(key);
      },
      visa: (citizenship, destination) => {
        const key = JSON.stringify([citizenship, destination]);
        if (!visas.has(key)) { visas.set(key, undefined); pending.push(Promise.resolve(ctx.visa(citizenship, destination)).then((check) => { visas.set(key, check); })); }
        return visas.get(key);
      } });
    if (!pending.length) return verdict;
    await Promise.all(pending);
  }
  return verdict!;
}

/**
 * Whether the person can take this up (§17.6), as code:
 * - the deadline (else the start) as an instant in the quote's own zone, compared with now: `expired`;
 * - latest start = deadline − preparation − visa lead − travel days, in the person's zone. When the opportunity has a deadline before its
 *   start, the visa and the journey count back from the start instead, since they run alongside the application: `no_time_to_prepare`
 *   when preparation alone no longer fits, `visa_too_late` when the visa does not;
 * - a local event more than `localMinutesMax` minutes away one way: `too_far` (conferences, competitions, internships carry their travel
 *   and cost instead); an in-person place that cannot be located for a local event: `place_unknown`;
 * - no availability window on the event's weekday: `no_free_time`;
 * - otherwise feasible, or `conflict` with each clashing block marked fixed or movable (§17.7).
 */
export function feasibilityNow(opportunity: Opportunity, ctx: SyncFeasibilityContext): Feasibility {
  const zone = ctx.timeZone;
  const now = ctx.now.getTime();
  const today = zonedParts(now, zone).day;
  const category = opportunityCategory(opportunity);
  const local = category === "local_event";
  const place: EventPlace = opportunity.place ?? { mode: "unknown", quote: "" };
  const reasons: Reason[] = [];
  const t = tFor(ctx.locale);

  // The deadline that counts: the earliest one still open in the person's clock; none left open is expired.
  const instants = opportunity.deadlines.map((item) => ({ item, at: quotedInstant(item, zone) })).filter((entry): entry is { item: DatedQuote; at: number } => entry.at !== undefined);
  const open = instants.filter((entry) => entry.at > now).sort((a, b) => a.at - b.at);
  const start = opportunity.startsAt && DAY.test(opportunity.startsAt.day) ? opportunity.startsAt : undefined;
  const startAt = start ? quotedInstant(start, zone, false) : undefined;
  if (instants.length && !open.length) reasons.push({ code: "expired", detail: t("截止 {{day}} 已过", { day: instants.map((entry) => entry.item.day).sort().at(-1) }) });
  if (!instants.length && startAt !== undefined && startAt <= now) reasons.push({ code: "expired", detail: t("{{day}} 已开始", { day: start!.day }) });
  if (reasons.length) return { state: "infeasible", reasons };
  const deadlineDay = open[0] ? zonedParts(open[0].at, zone).day : undefined;
  const eventDay = startAt !== undefined ? zonedParts(startAt, zone).day : undefined;
  const range = start ? quotedRange(start.quote) : undefined;

  // Where the person is on the day that matters, and where the event is.
  const keyDay = eventDay ?? deadlineDay ?? today;
  const person = placeOn(keyDay, ctx.places);
  const inPerson = place.mode === "in_person" || place.mode === "hybrid";
  let travel: TravelEstimate | undefined;
  let visa: VisaCheck | undefined;
  if (inPerson) {
    const here = person ? pointOf(person, ctx.geocode) : undefined, there = pointOf(place, ctx.geocode);
    if (here && there) {
      travel = travelEstimate(haversineKm(here, there));
      const limit = ctx.localMinutesMax ?? LOCAL_MINUTES_MAX;
      if (local && place.mode === "in_person" && travel.minutesOneWay > limit) {
        reasons.push({ code: "too_far", detail: t("单程约 {{minutes}} 分钟，超过本地活动的 {{limit}} 分钟", { minutes: travel.minutesOneWay, limit }) });
      }
    } else if (local && place.mode === "in_person") {
      reasons.push({ code: "place_unknown", detail: here ? t("活动地点无法定位") : t("不知道本人那天在哪里") });
    }
    // A visa only for going in person to another country than the one the person is in, and not their own.
    const destination = countryKey(there?.country ?? place.country);
    const from = countryKey(here?.country ?? person?.country);
    if (place.mode === "in_person" && destination && destination !== from && destination !== countryKey(ctx.citizenship)) {
      const read = ctx.citizenship ? ctx.visa(ctx.citizenship, there?.country ?? place.country ?? destination) : undefined;
      visa = read ?? { needed: "unknown", leadDays: VISA_LEAD_FALLBACK_DAYS, checkedAt: ctx.now.toISOString(), verified: false };
    }
  }

  // Latest start, in the person's local days.
  const visaLead = visa && visa.needed !== false ? visa.leadDays : 0;
  const travelDays = travel?.travelDays ?? 0;
  const anchor = deadlineDay ?? eventDay ?? today;
  const prepStart = addDay(anchor, -Math.max(0, ctx.prepDays));
  const separate = deadlineDay !== undefined && eventDay !== undefined && deadlineDay < eventDay;
  const visaStart = separate ? addDay(eventDay!, -(visaLead + travelDays)) : addDay(prepStart, -(visaLead + travelDays));
  const latestStart = visaStart < prepStart ? visaStart : prepStart;
  if (prepStart < today) reasons.push({ code: "no_time_to_prepare", detail: t("需提前 {{days}} 天准备，最晚 {{day}} 开始", { days: ctx.prepDays, day: prepStart }) });
  else if (visaStart < today) {
    reasons.push(visaLead > 0
      ? { code: "visa_too_late", detail: visa?.verified ? t("签证需约 {{days}} 天，最晚 {{day}} 开始办理", { days: visaLead, day: visaStart })
        : t("签证需约 {{days}} 天（未核实），最晚 {{day}} 开始办理", { days: visaLead, day: visaStart }) }
      : { code: "no_time_to_prepare", detail: t("路上需 {{days}} 天，最晚 {{day}} 出发", { days: travelDays, day: visaStart }) });
  }
  if (eventDay && !freeOnDay(eventDay, ctx.availability)) reasons.push({ code: "no_free_time", detail: t("{{day}} 没有可用时段", { day: eventDay }) });
  if (reasons.length) return { state: "infeasible", reasons };

  const clashes = eventDay ? eventClashes({ day: eventDay, range, travelMinutes: place.mode === "in_person" ? travel?.minutesOneWay ?? 0 : 0,
    travelDays: place.mode === "in_person" ? travelDays : 0 }, ctx.blocks) : [];
  const shared = { ...(person ? { place: person } : {}), ...(travel ? { travel } : {}), ...(visa ? { visa } : {}), latestStart };
  return clashes.length ? { state: "conflict", clashes, ...shared } : { state: "feasible", ...shared };
}

/** A clash in words for the card and the message (§17.7): what it is, whether it is fixed, and what moving it means. */
export function clashSentence(clash: CalendarClash, locale?: Locale): string {
  const t = tFor(locale);
  const values = { title: clash.title, day: clash.start.slice(5, 10), start: clash.start.slice(11, 16), end: clash.end.slice(11, 16) };
  return clash.fixed ? t("与「{{title}}」（{{day}} {{start}}–{{end}}，固定安排）冲突；移动它需要本人同意", values)
    : t("与「{{title}}」（{{day}} {{start}}–{{end}}，工作块）冲突；报名或加入计划后会重排", values);
}
