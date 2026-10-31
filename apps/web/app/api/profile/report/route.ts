import { resolveAccessContext } from "../../../../lib/access-guard";
import { changeProfileReport, loadProfileReport, readProfileReportChange } from "../../../../lib/profile-report";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The profile report by section, as the person sees it, with the card items they answered. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, ...loadProfileReport(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

/** `{action: privacy | claim_privacy | judge | item, …}` (`readProfileReportChange`); answers with the report as it now stands. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const change = readProfileReportChange(await request.json().catch(() => null));
  if (!change) return Response.json({ ok: false, code: "PROFILE_CHANGE_INVALID" }, { status: 400 });
  const result = changeProfileReport(access.ctx, change);
  return Response.json({ ...result, ...(result.ok ? loadProfileReport(access.ctx) : {}) }, { status: result.ok ? 200 : 400 });
}
