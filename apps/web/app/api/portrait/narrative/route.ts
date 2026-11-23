import { resolveAccessContext } from "../../../../lib/access-guard";
import { loadNarrative, rateNarrative } from "../../../../lib/portrait-narrative";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const VERDICTS = new Set(["fits", "partial", "off"]);

/** The portrait's narrative by section, with the person's ratings. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, narrative: loadNarrative(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

/** `{key, verdict: fits | partial | off, note?}`: the person's verdict on one section (`rateNarrative`). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { key?: unknown; verdict?: unknown; note?: unknown } | null;
  if (typeof body?.key !== "string" || !VERDICTS.has(String(body.verdict))) return Response.json({ ok: false, code: "NARRATIVE_RATING_INVALID" }, { status: 400 });
  const result = rateNarrative(access.ctx, { key: body.key, verdict: body.verdict as "fits" | "partial" | "off",
    ...(typeof body.note === "string" ? { note: body.note } : {}) });
  return Response.json(result.ok ? { ok: true, narrative: loadNarrative(access.ctx) } : result, { status: result.ok ? 200 : result.code === "NARRATIVE_NOT_YET_RATABLE" ? 409 : 400 });
}
