import type { AccessContext } from "@crossline/core";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { resolveAccessContext } from "../../../lib/access-guard";

/** The same two checks every writing route makes first — a cross-origin write is refused, then the session is resolved — plus a read of the JSON body. */
export async function writeGuard(request: Request): Promise<{ ctx: AccessContext; body: Record<string, unknown> } | { response: Response }> {
  if (isCrossSiteWrite(request)) return { response: Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 }) };
  const access = await resolveAccessContext(request);
  if ("response" in access) return access;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* an empty body is a body with nothing in it */ }
  return { ctx: access.ctx, body: (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown> };
}

export const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
