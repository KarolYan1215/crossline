import { lexiconEdits } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { serviceProxy } from "../../../../lib/service-proxy";

/**
 * What the person changed in text they dictated. The edit is worked out here from both texts (`lexiconEdits`), so a page cannot hand in
 * a wording that was never dictated; it is kept as their own wording for the next correction (Settings → 个性化 deletes it).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { dictated?: unknown; edited?: unknown } | null;
  const dictated = typeof body?.dictated === "string" ? body.dictated.slice(0, 2000) : "";
  const edited = typeof body?.edited === "string" ? body.edited.slice(0, 2000) : "";
  const edits = lexiconEdits(dictated, edited);
  if (!edits.length) return Response.json({ ok: true, kept: 0 });
  return serviceProxy(access.ctx, "/v1/voice/lexicon", { method: "POST", body: { edits } });
}
