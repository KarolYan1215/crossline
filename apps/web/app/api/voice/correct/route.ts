import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { serviceProxy } from "../../../../lib/service-proxy";
import { voicePreferences } from "../../../../lib/voice";

/** The correction of dictated text (Skill `crossline-dictation-corrector`); turned off in Settings → 通用, the text comes back as heard. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { raw?: unknown; language?: unknown; field?: unknown; page?: unknown } | null;
  const raw = typeof body?.raw === "string" ? body.raw.trim().slice(0, 4000) : "";
  if (!raw) return Response.json({ ok: false, code: "VOICE_TEXT_EMPTY" }, { status: 400 });
  if (!voicePreferences(access.ctx).correct) return Response.json({ ok: true, text: raw, count: 0, kept: "off" });
  const field = body?.field as { kind?: unknown; label?: unknown } | undefined;
  const page = body?.page as { kind?: unknown; entityId?: unknown } | undefined;
  return serviceProxy(access.ctx, "/v1/voice/correct", { method: "POST", timeoutMs: 75_000, body: { raw,
    language: typeof body?.language === "string" ? body.language.slice(0, 8) : "zh",
    field: { kind: typeof field?.kind === "string" ? field.kind.slice(0, 20) : "form", label: typeof field?.label === "string" ? field.label.slice(0, 40) : "" },
    ...(page && typeof page.entityId === "string" ? { page: { kind: typeof page.kind === "string" ? page.kind.slice(0, 20) : "", entityId: page.entityId.slice(0, 120) } } : {}) } });
}
