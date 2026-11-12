import { BIRTH_DATE_SETTING, BIRTH_YEAR_SETTING, ageFromBirth } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { appNow, getStore } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * `{birthDate}`: the day the person chose to give (`YYYY-MM-DD`), whose age places the energy prior's phase until their own sleep or best
 * hours do (docs/energy-and-ecosystem.md §2.1); `null` clears it. A plain setting, never one of the registration forms' secret items.
 * Either answer also drops a year kept from before the date was asked (2026-11-11), so only one answer is ever on file.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { birthDate?: unknown } | null;
  const store = getStore();
  const { workspaceId } = access.ctx;
  if (body?.birthDate === null) {
    store.deleteSetting(workspaceId, BIRTH_DATE_SETTING);
    store.deleteSetting(workspaceId, BIRTH_YEAR_SETTING);
    return Response.json({ ok: true, birthDate: null });
  }
  const date = typeof body?.birthDate === "string" ? body.birthDate.trim() : "";
  // A year alone is no longer an answer here: the card asks for the day.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ageFromBirth(date, appNow().toISOString()) === undefined)
    return Response.json({ ok: false, code: "INVALID_BIRTH_DATE" }, { status: 400 });
  store.setSetting(workspaceId, BIRTH_DATE_SETTING, date);
  store.deleteSetting(workspaceId, BIRTH_YEAR_SETTING);
  return Response.json({ ok: true, birthDate: date });
}
