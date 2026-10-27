import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { issueDeviceToken } from "../../../../lib/energy";

/**
 * A new token for a phone shortcut, shown once; the previous one of the same kind stops working at once. `{ "scope": "capture" }` makes
 * the Siri 「记一下」 token, `"records"` the one for payment
 * notifications and Wallet transactions (/api/records), `"recording"` the one that uploads recordings (docs/phone-recording.md),
 * anything else the health one.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { scope?: unknown };
  return Response.json({ ok: true, token: issueDeviceToken(access.ctx, body.scope === "capture" || body.scope === "records" || body.scope === "recording" ? body.scope : "health") });
}
