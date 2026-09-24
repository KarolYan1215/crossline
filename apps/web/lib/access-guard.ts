import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AccessContext } from "@crossline/core";
import { requireAccessContext } from "@crossline/auth";
import { getAuth } from "./auth";
import { getStore } from "./crossline";

export type ResolvedRoute = { ctx: AccessContext } | { response: Response };

/**
 * The one call every mutating (and now every reading) API route makes to turn a `Request` into an
 * `AccessContext`, right after `isCrossSiteWrite`. Early-return shape copied from
 * `apps/web/app/api/work-orders/[id]/guard.ts`'s `rejectUnsafeRequest` — same convention, but this one
 * hands back `ctx` on success instead of `undefined`, because every caller needs it next.
 */
export async function resolveAccessContext(request: Request): Promise<ResolvedRoute> {
  const result = await requireAccessContext(getAuth(), getStore(), request);
  if ("ctx" in result) return { ctx: result.ctx };
  const status = result.error === "UNAUTHENTICATED" ? 401 : 403;
  return { response: Response.json({ ok: false, code: result.error }, { status }) };
}

/**
 * The Server Component equivalent: there is no `Request` to read, only the incoming headers Next.js
 * exposes via `next/headers`. A page that calls this is unreachable without a session — `redirect`
 * throws internally, so nothing after the call runs unauthenticated, the same way `notFound()` works.
 */
export async function requireSessionContext(): Promise<AccessContext> {
  const request = new Request("http://internal.invalid/", { headers: await headers() });
  const result = await requireAccessContext(getAuth(), getStore(), request);
  if ("ctx" in result) return result.ctx;
  redirect("/login");
}
