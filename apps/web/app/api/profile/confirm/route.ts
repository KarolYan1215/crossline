import { PROFILE_CONFIRMED, portraitFingerprint, type ProfileModel } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * 「画像符合我」: the person confirms the portrait as it stands now. Kept with the portrait it was said about, so a portrait the interview
 * rewrites afterwards is asked about again — the one item of the completion list a model cannot tick.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const store = getStore();
  let profile: Partial<ProfileModel> = {};
  try { profile = JSON.parse(store.getSetting(access.ctx.workspaceId, "profile.model") ?? "{}") ?? {}; } catch { /* none */ }
  if (!String(profile.portrait ?? "").trim()) return Response.json({ ok: false, code: "PORTRAIT_EMPTY" }, { status: 400 });
  const at = new Date().toISOString();
  store.setSetting(access.ctx.workspaceId, PROFILE_CONFIRMED, JSON.stringify({ fingerprint: portraitFingerprint(profile), at }));
  store.appendEvent({ ownerId: access.ctx.principalId, workspaceId: access.ctx.workspaceId, idempotencyKey: `profile.confirmed:${at}`,
    type: "profile.confirmed", entityId: access.ctx.workspaceId, payload: { at } });
  return Response.json({ ok: true });
}
