import { NextResponse } from "next/server";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { serviceProxy } from "../../../../../lib/service-proxy";

/**
 * 「添加：按话题整理小红书收藏」 (Settings → Skill 库): `{lineId}` goes to the worker, which installs the topic workflow for that line as
 * `needs_consent` — the person then accepts its risks and logs in on its card, as for any workflow that reads an account.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown> = {};
  try { const parsed: unknown = await request.json(); if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>; } catch { /* checked below */ }
  const lineId = typeof body.lineId === "string" ? body.lineId : "";
  if (!/^[a-z0-9_-]{1,64}$/i.test(lineId)) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(access.ctx, "/v1/workflows/favourites-topics/install", { method: "POST", body: { lineId } });
}
