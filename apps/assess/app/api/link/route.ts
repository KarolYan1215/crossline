import { createHash, timingSafeEqual } from "node:crypto";
import { TYPE_TABLE, type AssessLinkResponse } from "@crossline/core/assess";
import { baseUrl } from "../../../server/config";
import { clientIp, fail, json, linkLookups, normaliseEmail } from "../../../server/security";
import { latestResultByEmail } from "../../../server/store";

/**
 * POST /api/link — the Crossline app asking, server to server, for the quick-test result held under a person's address
 * (`@crossline/core/assess` `assess-link.ts`; docs/assess-deploy.md 「与 App 的结果连接」). Off unless `ASSESS_LINK_SECRET` is set:
 * without it the route does not exist (404). The secret is compared in constant time over its SHA-256, so neither its content nor its
 * length leaks through timing. Answers the type and the four scores only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const digest = (text: string) => createHash("sha256").update(text).digest();

function authorised(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(digest(given), digest(secret)) && given.length > 0;
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.ASSESS_LINK_SECRET;
  if (!secret) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const limit = linkLookups.hit(clientIp(request));
  if (!limit.ok) return fail("RATE_LIMITED", limit.retryAfter);
  if (!authorised(request, secret)) return fail("UNAUTHORIZED");
  const body: unknown = await request.json().catch(() => undefined);
  const email = normaliseEmail(body && typeof body === "object" ? (body as { email?: unknown }).email : undefined);
  if (!email) return fail("EMAIL_INVALID");
  const result = latestResultByEmail(email);
  if (!result) return json({ found: false } satisfies AssessLinkResponse);
  const answer: AssessLinkResponse = {
    found: true, code: result.code, typeName: TYPE_TABLE[result.code]?.name ?? result.code, group: result.code.slice(0, 2),
    axes: { concentration: result.scores.concentration, orientation: result.scores.orientation, boundary: result.scores.boundary, pacing: result.scores.pacing },
    takenAt: result.createdAt,
    ...(process.env.ASSESS_BASE_URL ? {
      resultUrl: `${baseUrl()}/r/${result.resultToken}`,
      figureUrl: `${baseUrl()}/api/avatar/${result.inviteToken}.png?size=small`
    } : {})
  };
  return json(answer);
}
