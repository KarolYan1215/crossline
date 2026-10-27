/**
 * The person's life on the same calendar as their work (2026-10-27, the owner: 「生活和工作都要覆盖，人不可能一直工作」): reminders that need no
 * work, and the time it takes to get somewhere. Pure; the web reads and writes the settings (`apps/web/lib/life.ts`).
 */

import { tFor, type Locale } from "./i18n";

/** Reminders the person asked for (「明天上午提醒我取快递」), and the departure reminders errands set. `schedule.` so an undo takes one back. */
export const REMINDERS_SETTING = "schedule.reminders";
/** Home and work address, the default travel time and whether a map may be asked (`TravelSettings`). */
export const TRAVEL_SETTING = "schedule.travel";
/** Travel minutes per place the person gave (「去学校 25 分钟」, or answered when asked); `"online"` = nothing to travel to. */
export const TRAVEL_PLACES_SETTING = "schedule.travel.places";
/** Map estimates per place, and geocodes per address (a cache, not the person's word). */
export const TRAVEL_ESTIMATES_SETTING = "travel.estimates";

/** When a reminder with no time is said, and the travel time taken while nothing is known (the person is asked meanwhile). */
export const DEFAULT_REMINDER_TIME = "09:00";
export const ASSUMED_TRAVEL_MINUTES = 30;
/** Leave this much earlier than the travel time alone says. */
export const DEPARTURE_MARGIN_MINUTES = 15;

export type Reminder = {
  id: string; text: string;
  /** The person's local day and time it is said on. */
  date: string; time: string;
  /** Checks before leaving (检查油量, 带会员卡), listed in the departure reminder. */
  checklist?: string[];
  /** A departure reminder: said `DEPARTURE_MARGIN_MINUTES` plus the travel time before the event starts (worked out when it is due). */
  departure?: { title: string; location: string; start: string };
  /** The assistant's preparation for it (a work order id), named in the reminder once ready. */
  errandOrderId?: string;
  firedAt?: string;
};

export type TravelSettings = { home: string; work: string; defaultMinutes: number; useMap: boolean };
export type TravelState = {
  settings: TravelSettings;
  places: Record<string, number | "online">;
  estimates: { routes: Record<string, { minutes: number; at: string } | { failed: string }>; geocode: Record<string, { lat: number; lon: number } | null> };
};
export type TravelSource = "online" | "person" | "map" | "default" | "assumed";

const json = <T,>(raw: string | undefined | null, fallback: T): T => { try { return (raw ? JSON.parse(raw) : null) ?? fallback; } catch { return fallback; } };

export function readTravelState(get: (key: string) => string | undefined | null): TravelState {
  const settings = json<Partial<TravelSettings>>(get(TRAVEL_SETTING), {});
  const estimates = json<Partial<TravelState["estimates"]>>(get(TRAVEL_ESTIMATES_SETTING), {});
  return {
    settings: { home: settings.home ?? "", work: settings.work ?? "", defaultMinutes: Number(settings.defaultMinutes) || 0, useMap: settings.useMap !== false },
    places: json<TravelState["places"]>(get(TRAVEL_PLACES_SETTING), {}),
    estimates: { routes: estimates.routes ?? {}, geocode: estimates.geocode ?? {} }
  };
}

/** A meeting link or a word saying it happens online: nothing to travel to. */
const ONLINE = /https?:\/\/|\bzoom\b|\bteams\b|google meet|\bmeet\.google|\bwebex\b|\bonline\b|\bremote\b|\bvirtual\b|线上|远程|在线|视频会议|腾讯会议|飞书会议|钉钉会议/i;
export const isOnlineLocation = (location: string): boolean => ONLINE.test(location);

/** One key per place, however it was typed (case, spaces, punctuation). */
export const placeKey = (location: string): string => location.trim().toLowerCase().replace(/[\s,，。.;；:：()（）"'“”]+/g, " ").trim().slice(0, 120);

/** Words that mean the person's workplace or school, so 「去学校通勤 25 分钟」 and an event 「在公司」 share the work address. */
const WORKPLACE = /^(公司|办公室|单位|学校|校园|实验室|lab|office|work|campus|school)$/i;
/** The address a map estimate is asked for: the work address for a workplace word, else the place itself. */
export const mapAddress = (location: string, settings: TravelSettings): string => WORKPLACE.test(placeKey(location)) && settings.work ? settings.work : location.trim();

/**
 * How long getting to a place takes, in this order: nothing for an online one; what the person said for it; a map estimate (only with a
 * home address and the map allowed); the person's default; else `ASSUMED_TRAVEL_MINUTES`, and the person is asked once (`assumed`).
 */
export function travelMinutesFor(location: string, state: TravelState): { minutes: number; source: TravelSource } {
  if (!location.trim() || isOnlineLocation(location)) return { minutes: 0, source: "online" };
  const key = placeKey(location);
  const given = state.places[key] ?? (WORKPLACE.test(key) && state.settings.work ? state.places[placeKey(state.settings.work)] : undefined);
  if (given === "online") return { minutes: 0, source: "online" };
  if (typeof given === "number" && given >= 0) return { minutes: given, source: "person" };
  const route = state.estimates.routes[placeKey(mapAddress(location, state.settings))];
  if (state.settings.home && state.settings.useMap && route && "minutes" in route) return { minutes: route.minutes, source: "map" };
  if (state.settings.defaultMinutes > 0) return { minutes: state.settings.defaultMinutes, source: "default" };
  return { minutes: ASSUMED_TRAVEL_MINUTES, source: "assumed" };
}

/** Whether a map estimate is worth asking for this place: allowed, a home to start from, and none tried yet. */
export function wantsMapEstimate(location: string, state: TravelState): boolean {
  if (!state.settings.home || !state.settings.useMap || !location.trim() || isOnlineLocation(location)) return false;
  const key = placeKey(location);
  if (state.places[key] !== undefined) return false;
  return !state.estimates.routes[placeKey(mapAddress(location, state.settings))];
}

type Block = { id: string; day?: string; start: string; end: string; location?: string };
const toMinutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * 「路上」: for every dated block at a physical place, the travel time before and after it as busy time of its own, so the plan leaves it
 * free and the day view draws it. Kept inside the day.
 */
// ponytail: each event is travelled to from home and back; two events at one place back to back still get travel between them.
export function travelBlocks(blocks: Block[], state: TravelState, locale?: Locale) {
  const t = tFor(locale);
  return blocks.flatMap((block) => {
    if (!block.day || !block.location) return [];
    const { minutes } = travelMinutesFor(block.location, state);
    if (minutes <= 0) return [];
    const start = toMinutes(block.start), end = toMinutes(block.end);
    const to = Math.max(0, start - minutes), back = Math.min(23 * 60 + 59, end + minutes);
    const base = { lane: "human" as const, title: t("路上"), day: block.day, source: t("通勤"), readOnly: true, tag: t("约 {{count}} 分钟", { count: minutes }) };
    return [...(to < start ? [{ ...base, id: `travel:${block.id}:to`, start: clock(to), end: block.start }] : []),
      ...(back > end ? [{ ...base, id: `travel:${block.id}:back`, start: block.end, end: clock(back) }] : [])];
  });
}

/** When a departure reminder is said: travel and the margin before the start (never before 00:00). */
export function departureTime(start: string, travelMinutes: number): string {
  return clock(Math.max(0, toMinutes(start) - travelMinutes - DEPARTURE_MARGIN_MINUTES));
}
