import { resolveAccessContext } from "../../../lib/access-guard";
import { loadPortrait, requestPortrait } from "../../../lib/portrait";
import { isCrossSiteWrite } from "../../../lib/same-origin";

/** The portrait report and whether one is being written. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, ...loadPortrait(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

/** Writes (or rewrites) the portrait from the interview. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const result = await requestPortrait(access.ctx);
  return Response.json(result, { status: result.ok ? 202 : 503 });
}
