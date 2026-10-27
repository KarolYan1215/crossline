import { resolveAccessContext } from "../../../../lib/access-guard";
import { interviewQuota } from "../../../../lib/interview-quota";

/** Whether the ChatGPT quota carries the interview; `?limit=1` when the page's last round stopped on a spent quota. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const limit = new URL(request.url).searchParams.get("limit") === "1";
  return Response.json(await interviewQuota(access.ctx, limit ? { usageLimitHit: true } : {}));
}
