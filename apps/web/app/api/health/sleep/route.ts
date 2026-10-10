import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { storeHealthSummary, workspaceForHealthToken } from "../../../../lib/energy";

const MAX_BYTES = 64_000;

/**
 * The phone's shortcut posts last night's sleep (and, when it has them, the day's heart-rate variability and resting heart rate) here,
 * over the tailnet, with the token shown once in 设置 → 隐私 as `Authorization: Bearer <token>`. No session: a shortcut has none. Only
 * summaries are kept (docs/one-input.md §5).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const token = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const workspaceId = token ? workspaceForHealthToken(token) : undefined;
  if (!workspaceId) return Response.json({ ok: false, code: "HEALTH_TOKEN_INVALID" }, { status: 401 });
  const text = await request.text();
  if (text.length > MAX_BYTES) return Response.json({ ok: false, code: "HEALTH_BODY_TOO_LARGE" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  return Response.json({ ok: true, ...storeHealthSummary(workspaceId, body) });
}
