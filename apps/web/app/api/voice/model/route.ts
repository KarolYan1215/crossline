import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { serviceProxy } from "../../../../lib/service-proxy";

/** An installed copy downloads SenseVoice for voice input only from this request, sent by the button that names its source and size. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { consent?: unknown } | null;
  if (body?.consent !== true) return Response.json({ ok: false, code: "VOICE_CONSENT_REQUIRED" }, { status: 400 });
  return serviceProxy(access.ctx, "/v1/voice/model", { method: "POST", body: { consent: true } });
}
