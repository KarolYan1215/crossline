import { BIRTH_YEAR_SETTING, ageFromBirthYear } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { appNow, getStore } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * `{birthYear}`: the year the person chose to give, which only places the energy prior's phase until their own sleep or best hours do
 * (docs/energy-and-ecosystem.md §2.1); `null` clears it. A plain setting, never one of the registration forms' secret items.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { birthYear?: unknown } | null;
  const store = getStore();
  if (body?.birthYear === null) {
    store.deleteSetting(access.ctx.workspaceId, BIRTH_YEAR_SETTING);
    return Response.json({ ok: true, birthYear: null });
  }
  const year = typeof body?.birthYear === "number" ? String(body.birthYear) : typeof body?.birthYear === "string" ? body.birthYear.trim() : "";
  if (ageFromBirthYear(year, appNow().toISOString()) === undefined) return Response.json({ ok: false, code: "INVALID_BIRTH_YEAR" }, { status: 400 });
  store.setSetting(access.ctx.workspaceId, BIRTH_YEAR_SETTING, year);
  return Response.json({ ok: true, birthYear: Number(year) });
}
