import { ACTIVITY_BLACKLIST, ACTIVITY_DETAIL_CONSENT, ACTIVITY_PAUSED_UNTIL, getStore, LOCAL_ACTIVITY_CONSENT } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** What the settings card shows: the two consents, the pause, the person's own blacklist, and — the one place titles are readable — what is kept. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const store = getStore(), workspaceId = access.ctx.workspaceId;
  const level = (key: string) => store.getSetting(workspaceId, key) === "granted" ? "granted" : store.getSetting(workspaceId, key) === "denied" ? "denied" : "unasked";
  let blacklist: string[] = [];
  try { const parsed = JSON.parse(store.getSetting(workspaceId, ACTIVITY_BLACKLIST) ?? "[]") as unknown; if (Array.isArray(parsed)) blacklist = parsed.filter((item): item is string => typeof item === "string"); } catch { /* unreadable list counts as empty */ }
  return Response.json({
    ok: true, minutes: level(LOCAL_ACTIVITY_CONSENT), detail: level(ACTIVITY_DETAIL_CONSENT),
    pausedUntil: store.getSetting(workspaceId, ACTIVITY_PAUSED_UNTIL) ?? null, blacklist,
    entries: store.recentActivityEntries(workspaceId, 30)
  });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { consent?: unknown; detail?: unknown; pauseMinutes?: unknown; blacklist?: unknown; clearTitles?: unknown };
  const store = getStore(), workspaceId = access.ctx.workspaceId;
  let touched = false;

  // Only the answers a person can actually give. Absent stays absent — never asked is a real state.
  if (body.consent !== undefined) {
    if (body.consent !== "granted" && body.consent !== "denied") return Response.json({ ok: false, code: "CONSENT_VALUE_INVALID" }, { status: 400 });
    store.setSetting(workspaceId, LOCAL_ACTIVITY_CONSENT, body.consent);
    // Turning the whole thing off turns the detailed level off too: one switch must not leave a quieter one running.
    if (body.consent === "denied") store.setSetting(workspaceId, ACTIVITY_DETAIL_CONSENT, "denied");
    touched = true;
  }
  if (body.detail !== undefined) {
    if (body.detail !== "granted" && body.detail !== "denied") return Response.json({ ok: false, code: "CONSENT_VALUE_INVALID" }, { status: 400 });
    store.setSetting(workspaceId, ACTIVITY_DETAIL_CONSENT, body.detail);
    // The detailed level includes the minutes; asking for it grants both so nothing is half on.
    if (body.detail === "granted") store.setSetting(workspaceId, LOCAL_ACTIVITY_CONSENT, "granted");
    touched = true;
  }
  if (body.pauseMinutes !== undefined) {
    const minutes = Number(body.pauseMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) return Response.json({ ok: false, code: "PAUSE_INVALID" }, { status: 400 });
    // 0 resumes now. Stored as an instant so it expires by itself, with nothing left to remember to switch back on.
    store.setSetting(workspaceId, ACTIVITY_PAUSED_UNTIL, minutes === 0 ? "" : new Date(Date.now() + minutes * 60_000).toISOString());
    touched = true;
  }
  if (body.blacklist !== undefined) {
    if (!Array.isArray(body.blacklist) || body.blacklist.length > 100 || body.blacklist.some((word) => typeof word !== "string" || word.length > 60)) {
      return Response.json({ ok: false, code: "BLACKLIST_INVALID" }, { status: 400 });
    }
    store.setSetting(workspaceId, ACTIVITY_BLACKLIST, JSON.stringify((body.blacklist as string[]).map((word) => word.trim()).filter(Boolean)));
    touched = true;
  }
  let cleared = 0;
  if (body.clearTitles === true) { cleared = store.clearActivityTitles(workspaceId); touched = true; }
  if (!touched) return Response.json({ ok: false, code: "NOTHING_TO_CHANGE" }, { status: 400 });
  return Response.json({ ok: true, cleared });
}
