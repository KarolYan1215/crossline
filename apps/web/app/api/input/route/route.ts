import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { routeInput, setAutoApplySchedule, type Mention } from "../../../../lib/input";

const KINDS = new Set(["material", "task", "milestone"]);

/**
 * `{text, batch, mentions}`: a batch or an instruction from 快速收集, split by the router — captures written, changes to planned tasks
 * returned for preview. `{autoApply: boolean}` alone records whether such changes are applied at once from now on.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; batch?: unknown; mentions?: unknown; autoApply?: unknown };
  if (typeof body.autoApply === "boolean" && body.text === undefined) { setAutoApplySchedule(access.ctx, body.autoApply); return Response.json({ ok: true }); }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!text) return Response.json({ ok: false, code: "INPUT_EMPTY" }, { status: 400 });
  const mentions: Mention[] = Array.isArray(body.mentions) ? (body.mentions as Array<Record<string, unknown>>)
    .filter((item) => KINDS.has(String(item.kind)) && typeof item.id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(item.id))
    .map((item) => ({ kind: item.kind as Mention["kind"], id: String(item.id), title: String(item.title ?? "").slice(0, 200) })).slice(0, 20) : [];
  return Response.json({ ok: true, ...(await routeInput(access.ctx, { text, batch: body.batch === true, mentions })) });
}
