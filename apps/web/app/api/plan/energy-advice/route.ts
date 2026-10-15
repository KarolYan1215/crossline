import { ENERGY_ADVICE_DISMISSED, ENERGY_ADVICE_SETTING, readEnergyAdvice } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * `{action: "dismiss", id}`: sets this week's energy advice aside (「忽略」). Only the advice that is current can be set aside, and only it:
 * next week's different advice is shown again. Approving it goes through `/api/plan/impact` like any change to the hours.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; id?: unknown };
  const store = getStore();
  const advice = readEnergyAdvice(store.getSetting(access.ctx.workspaceId, ENERGY_ADVICE_SETTING));
  if (body.action !== "dismiss" || !advice || !("id" in advice) || body.id !== advice.id)
    return Response.json({ ok: false, code: "ENERGY_ADVICE_NOT_CURRENT" }, { status: 400 });
  store.setSetting(access.ctx.workspaceId, ENERGY_ADVICE_DISMISSED, advice.id);
  store.appendEvent({ ownerId: access.ctx.principalId, workspaceId: access.ctx.workspaceId, idempotencyKey: `energy.advice.dismissed:${advice.id}`,
    type: "energy.advice.dismissed", entityId: access.ctx.workspaceId, payload: { id: advice.id } });
  return Response.json({ ok: true });
}
