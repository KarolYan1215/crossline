import { NextResponse } from "next/server";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { serviceProxy } from "../../../../../lib/service-proxy";

/**
 * 「按链接添加」 a public skill (docs/skills-library.md §2): `{repo, path, lineId, why?, category?}` goes to the worker, which fetches,
 * scans and reviews it exactly as it does the scout's candidates and answers at once with a job id (202); the review runs behind it.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown> = {};
  try { const parsed: unknown = await request.json(); if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>; } catch { /* checked by the worker */ }
  const text = (key: string, max: number) => typeof body[key] === "string" ? (body[key] as string).slice(0, max) : "";
  return serviceProxy(access.ctx, "/v1/skills/public/install", { method: "POST",
    body: { repo: text("repo", 300), path: text("path", 300), lineId: text("lineId", 64), why: text("why", 300), category: text("category", 20) } });
}

/** `?job=<id>`: how one installation ended (`running`, `installed`, `already`, `rejected` or `blocked`, with the reason). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const job = new URL(request.url).searchParams.get("job") ?? "";
  if (!/^[a-z0-9-]{1,64}$/.test(job)) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(access.ctx, `/v1/skills/public/install/${job}`);
}
