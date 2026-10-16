import { parseWants } from "@crossline/core/assess-wants";
import { clientIp, crossSiteWrite, fail, json, lookupBlocked, lookupMissed, wantsPerIp } from "../../../../../server/security";
import { WANTS_UPDATES_MAX, getResultByToken, setWants } from "../../../../../server/store";
import { composeWants } from "../../../../../server/wants";

type Context = { params: Promise<{ token: string }> };

/**
 * POST /api/results/[resultToken]/wants: what the person wants to do (chips and an optional free line), asked right after the email so
 * their figure is drawn while they answer. The three lines made from it replace the type's suggestion on their page and posters. Keyed by
 * the result token — only the person sets it; others see the lines through the invitation and pair views. Each result may set it
 * `WANTS_UPDATES_MAX` times (each may call the text model), and the per-address limit slows anyone driving it in a loop. The free line is
 * kept for the person's own page only.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  if (crossSiteWrite(request)) return fail("REJECTED");
  const blocked = lookupBlocked(request);
  if (blocked) return blocked;
  const byIp = wantsPerIp.hit(clientIp(request));
  if (!byIp.ok) return fail("RATE_LIMITED", byIp.retryAfter);
  const { token } = await context.params;
  const result = getResultByToken(token);
  if (!result) return lookupMissed(request);
  const wants = parseWants(await request.json().catch(() => undefined));
  if (!wants) return fail("WANTS_INVALID");
  if ((result.wantsUpdates ?? 0) >= WANTS_UPDATES_MAX) return fail("WANTS_LIMIT_REACHED");
  const lines = await composeWants(result, wants);
  if (!setWants(result.id, { input: wants, lines })) return fail("WANTS_LIMIT_REACHED");
  return json({ ok: true });
}
