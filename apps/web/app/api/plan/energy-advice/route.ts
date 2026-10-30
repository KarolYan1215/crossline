import { resolveAccessContext } from "../../../../lib/access-guard";
import { dismissEnergyAdvice } from "../../../../lib/consents";
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
  if (body.action !== "dismiss" || typeof body.id !== "string") return Response.json({ ok: false, code: "ENERGY_ADVICE_NOT_CURRENT" }, { status: 400 });
  const result = dismissEnergyAdvice(access.ctx, body.id);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
