import "server-only";
import {
  TRAVEL_ESTIMATES_SETTING, TRAVEL_PLACES_SETTING, TRAVEL_SETTING, isOnlineLocation, mapAddress, occurrences, placeKey, travelMinutesFor, wantsMapEstimate,
  type AccessContext, type TravelSettings
} from "@crossline/core";
import { getStore, planToday, travelStateOf, type PersistedScheduleBlock } from "./crossline";
import { inputEvents } from "./fixed-events";
import { estimateTravelMinutes } from "./map-travel";

/** Getting to the places on the calendar (「路上」, `travelBlocks` in core): the person's settings, their word per place, map estimates. */
const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Changes the person's travel settings; a new home or work address forgets the map's routes (they started elsewhere). */
export function setTravel(ctx: AccessContext, patch: Partial<TravelSettings>): TravelSettings {
  const store = getStore();
  const state = travelStateOf(ctx);
  const next: TravelSettings = { ...state.settings, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  next.home = next.home.trim().slice(0, 200); next.work = next.work.trim().slice(0, 200);
  next.defaultMinutes = Math.max(0, Math.min(240, Math.round(Number(next.defaultMinutes) || 0)));
  store.setSetting(ctx.workspaceId, TRAVEL_SETTING, JSON.stringify(next));
  if (next.home !== state.settings.home || next.work !== state.settings.work)
    store.setSetting(ctx.workspaceId, TRAVEL_ESTIMATES_SETTING, JSON.stringify({ ...state.estimates, routes: {} }));
  return next;
}

/** The person's own travel time to one place (`"online"`: nothing to travel to). */
export function setPlaceMinutes(ctx: AccessContext, place: string, minutes: number | "online"): void {
  const key = placeKey(place);
  if (!key) return;
  const places = travelStateOf(ctx).places;
  getStore().setSetting(ctx.workspaceId, TRAVEL_PLACES_SETTING, JSON.stringify({ ...places, [key]: minutes === "online" ? "online" : Math.max(0, Math.min(240, Math.round(minutes))) }));
}

/** Places of the next seven days' events (the person's own and synced ones), each with the first day it comes up. */
export function upcomingPlaces(ctx: AccessContext): Array<{ location: string; day: string; title: string }> {
  const today = planToday(ctx);
  const week = Array.from({ length: 7 }, (_, index) => addDays(today, index));
  const plan = getStore().listPlanVersions(ctx.workspaceId)[0];
  const synced = (((plan?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)?.blocks) ?? [])
    .filter((block) => block.location && block.day && week.includes(block.day)).map((block) => ({ location: block.location!, day: block.day!, title: block.title }));
  const own = inputEvents(ctx).filter((event) => event.location).flatMap((event) => {
    const day = occurrences(event, week)[0];
    return day ? [{ location: event.location, day, title: event.title }] : [];
  });
  const seen = new Map<string, { location: string; day: string; title: string }>();
  for (const item of [...own, ...synced].sort((a, b) => a.day.localeCompare(b.day))) {
    if (!isOnlineLocation(item.location) && !seen.has(placeKey(item.location))) seen.set(placeKey(item.location), item);
  }
  return [...seen.values()];
}

/** Places whose travel time is only the assumed half hour (no word, no map, no default): asked about once each, two at a time. */
export function placesToAsk(ctx: AccessContext): Array<{ location: string; day: string; title: string }> {
  const state = travelStateOf(ctx);
  return upcomingPlaces(ctx).filter((item) => travelMinutesFor(item.location, state).source === "assumed" && !wantsMapEstimate(item.location, state)).slice(0, 2);
}

/** Asks the map for the places that need it (at most three a pass, in the background); each outcome is kept, a failure too. */
export async function refreshTravelEstimates(ctx: AccessContext, options: { fetch?: typeof fetch } = {}): Promise<number> {
  const state = travelStateOf(ctx);
  const todo = upcomingPlaces(ctx).filter((item) => wantsMapEstimate(item.location, state)).slice(0, 3);
  if (!todo.length) return 0;
  const geocode = { ...state.estimates.geocode };
  const routes = { ...state.estimates.routes };
  for (const item of todo) {
    const address = mapAddress(item.location, state.settings);
    const result = await estimateTravelMinutes(state.settings.home, address, geocode, options.fetch ? { fetch: options.fetch, paced: false } : {});
    routes[placeKey(address)] = "minutes" in result ? { minutes: result.minutes, at: new Date().toISOString() } : result;
  }
  getStore().setSetting(ctx.workspaceId, TRAVEL_ESTIMATES_SETTING, JSON.stringify({ routes, geocode }));
  return todo.length;
}
