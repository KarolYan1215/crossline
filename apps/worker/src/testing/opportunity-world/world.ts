import type { ReadItem } from "@crossline/core";
import type { SafeGetDeps } from "../../safe-fetch";

/**
 * The synthetic world the opportunity agent is tested in (docs/opportunity-agent.md §17.9 ③): every site, job board, deadline list,
 * mailbox, calendar, geocoder and visa page the agent can reach, local and deterministic. Nothing here touches the network; every
 * request the agent makes is answered from `routes` and written to `log`, so a test can say which hosts were asked for what.
 *
 * The clock is fixed at 21:30 on Monday 2 November 2026 in Madison (America/Chicago, CST since 1 November): still the 2nd where the
 * person is, already the 3rd in UTC. That hour is chosen on purpose — a registration that closes tonight is open, and a pipeline that
 * takes "today" from UTC drops it (§17.5).
 */
export const WORLD_START = new Date("2026-11-03T03:30:00.000Z");
export const PERSON_ZONE = "America/Chicago";
export const DAY_MS = 86_400_000;

/** One page of the world, with what a faithful reader takes from it and, when a plausible model would get it wrong, what that model takes. */
export type WorldPage = {
  url: string;
  /** The page as served; `type` defaults to text/html. A page with `status` other than 200 does not open. */
  body: string;
  type?: string;
  status?: number;
  /** From this day on (index into the run, 0 = the start); a page that did not exist yet answers 404. */
  fromDay?: number;
};

/** A reading as the reader Skill returns it, keyed by the url it is about (the pipeline sets `pageId`). */
export type Reading = Omit<ReadItem, "pageId">;

/** A result of the web search tool: the page a query leads to and what the model claims about it. */
/** No `reading`: a faithful model finds nothing there worth returning. */
export type SearchHit = { query: string; reading?: Reading | undefined; adversarial?: Reading[] | undefined; fromDay?: number };

export type MailMessage = { key: string; lineId: string; from: string; subject: string; text: string; url: string; at: string; kind: "opportunity" | "travel" };

/** A calendar block: a fixed arrangement (a class, an exam, someone else's meeting) or a movable work block the scheduler placed. */
export type CalendarBlock = { id: string; title: string; start: string; end: string; fixed: boolean; location?: string | undefined };

/** An official page saying how long a visa takes, for one citizenship and destination (§17.6). */
export type VisaPage = { citizenship: string; destination: string; url: string; needed: boolean; leadDays: number; quote: string };

export type Place = { name: string; lat: number; lon: number; country: string };

export type FetchRecord = { url: string; host: string; status: number; day: number };

export type World = {
  pages: Map<string, WorldPage>;
  search: SearchHit[];
  mail: MailMessage[];
  calendar: CalendarBlock[];
  places: Place[];
  visas: VisaPage[];
  /** Hosts that exist only because a page's injected text named them; any request to one is an injection carried out. */
  injectedHosts: Set<string>;
  log: FetchRecord[];
  /** The run's day index, moved by the harness; pages and search hits with `fromDay` appear on that day. */
  day: number;
};

export function emptyWorld(): World {
  return { pages: new Map(), search: [], mail: [], calendar: [], places: [], visas: [], injectedHosts: new Set(), log: [], day: 0 };
}

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

/** A page body in the shape sites have: a title and paragraphs. */
export const html = (title: string, ...paragraphs: string[]) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${paragraphs.map((text) => `<p>${text}</p>`).join("")}</body></html>`;

/**
 * The world's network as `safeGet` sees it. Nominatim answers from `places` (`/search?q=…&format=json`, the shape OSM returns), every
 * other address from `pages`; anything else is a 404. Every request lands in `log`, including the ones that fail.
 */
export function worldHttp(world: World): SafeGetDeps {
  return {
    isPublicHost: async () => true,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const host = hostOf(url);
      const answer = (status: number, body: string, type: string) => {
        world.log.push({ url, host, status, day: world.day });
        return new Response(body, { status, headers: { "content-type": type } });
      };
      if (host === "nominatim.openstreetmap.org") {
        const q = (new URL(url).searchParams.get("q") ?? "").toLowerCase();
        const hit = world.places.find((place) => q && (place.name.toLowerCase().includes(q) || q.includes(place.name.toLowerCase().split(",")[0]!)));
        return answer(200, JSON.stringify(hit ? [{ lat: String(hit.lat), lon: String(hit.lon), display_name: hit.name,
          address: { country: hit.country } }] : []), "application/json");
      }
      const page = world.pages.get(url) ?? world.pages.get(url.split("#")[0]!);
      if (!page || (page.fromDay ?? 0) > world.day) return answer(404, "not found", "text/plain");
      return answer(page.status ?? 200, page.body, page.type ?? "text/html");
    }) as typeof fetch
  };
}

/** The search tool's answer to a query on the current day: hits whose query shares its words. */
export function searchWorld(world: World, query: string): SearchHit[] {
  const words = (text: string) => new Set(text.toLowerCase().replace(/site:\S+/g, "").split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const wanted = words(query);
  return world.search.filter((hit) => (hit.fromDay ?? 0) <= world.day && [...words(hit.query)].every((word) => wanted.has(word)));
}

/** Great-circle distance in km between two places (the same arithmetic §17.6 asks the engine to do; used here only to state ground truth). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (deg: number) => deg * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
