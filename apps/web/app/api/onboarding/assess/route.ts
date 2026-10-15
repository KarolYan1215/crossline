import { NextResponse } from "next/server";
import { getStore } from "../../../../lib/crossline";
import { getAuth } from "../../../../lib/auth";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { assessOffer, decideAssess } from "../../../../lib/assess-link";

/** The session's address, only when the person has proven it is theirs: the test's answer is that person's own. */
async function verifiedEmail(request: Request): Promise<string | undefined> {
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    return session?.user.emailVerified && session.user.email ? session.user.email : undefined;
  } catch { return undefined; }
}

/** The public quick test's result for this account (`lib/assess-link.ts`): offered, used, declined, none, or off. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json(await assessOffer(getStore(), access.ctx.workspaceId, await verifiedEmail(request)), { headers: { "cache-control": "no-store" } });
}

/** `{decision: "use" | "reject"}`: 「使用该结果」 or 「不是我的结果」/「移除」. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { decision?: unknown } | null;
  if (body?.decision !== "use" && body?.decision !== "reject") return NextResponse.json({ ok: false, code: "INVALID_DECISION" }, { status: 400 });
  return NextResponse.json(await decideAssess(getStore(), access.ctx.workspaceId, await verifiedEmail(request), body.decision));
}
