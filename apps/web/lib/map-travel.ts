/**
 * Travel time from a map (2026-10-27): OpenStreetMap's Nominatim turns an address into coordinates and the public OSRM service routes
 * between two. Asked only when the person set a home address and left the map on (`TravelSettings.useMap`), in the background, never
 * while a page renders. Nominatim's usage policy: an identifying User-Agent and at most one request a second; geocodes are cached.
 */
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const USER_AGENT = "Crossline/1.0 (personal planner; travel-time estimate)";
const TIMEOUT_MS = 8_000;
const NOMINATIM_GAP_MS = 1_100;

export type Geocodes = Record<string, { lat: number; lon: number } | null>;
type Fetch = typeof fetch;

let lastNominatimAt = 0;
async function spaced(): Promise<void> {
  const wait = lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimAt = Date.now();
}

async function geocode(address: string, cache: Geocodes, fetchImpl: Fetch, paced: boolean): Promise<{ lat: number; lon: number } | null> {
  const key = address.trim().toLowerCase();
  if (key in cache) return cache[key] ?? null;
  if (paced) await spaced();
  const response = await fetchImpl(`${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(address.trim())}`,
    { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GEOCODE_HTTP_${response.status}`);
  const rows = await response.json() as Array<{ lat?: string; lon?: string }>;
  const lat = Number(rows[0]?.lat), lon = Number(rows[0]?.lon);
  cache[key] = Number.isFinite(lat) && Number.isFinite(lon) && rows[0] ? { lat, lon } : null;
  return cache[key] ?? null;
}

/**
 * Driving minutes from `from` to `to`, rounded up to five; `failed` with a code when either address is not found or a service does not
 * answer. `cache` is updated in place with every geocode tried (a miss is cached too, so it is not asked again).
 */
// ponytail: driving only (the public OSRM server's profile); add transit/walking when a person without a car asks.
export async function estimateTravelMinutes(from: string, to: string, cache: Geocodes, options: { fetch?: Fetch; paced?: boolean } = {}):
  Promise<{ minutes: number } | { failed: string }> {
  const fetchImpl = options.fetch ?? fetch, paced = options.paced ?? true;
  try {
    const a = await geocode(from, cache, fetchImpl, paced);
    if (!a) return { failed: "HOME_NOT_FOUND" };
    const b = await geocode(to, cache, fetchImpl, paced);
    if (!b) return { failed: "PLACE_NOT_FOUND" };
    const response = await fetchImpl(`${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`,
      { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { failed: `ROUTE_HTTP_${response.status}` };
    const body = await response.json() as { routes?: Array<{ duration?: number }> };
    const seconds = body.routes?.[0]?.duration;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return { failed: "ROUTE_NOT_FOUND" };
    return { minutes: Math.max(5, Math.ceil(seconds / 60 / 5) * 5) };
  } catch (error) {
    return { failed: error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : "MAP_UNREACHABLE" };
  }
}
