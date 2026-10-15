import { getStore } from "../../../../../lib/crossline";
import { getAuth } from "../../../../../lib/auth";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { assessFigure, assessOffer } from "../../../../../lib/assess-link";

/** The quick test's figure for this account's offered or used result, served from this origin (`assessFigure`); 404 when there is none. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let email: string | undefined;
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    email = session?.user.emailVerified && session.user.email ? session.user.email : undefined;
  } catch { email = undefined; }
  const offer = await assessOffer(getStore(), access.ctx.workspaceId, email);
  const figure = offer.state === "offered" || offer.state === "used" ? await assessFigure(offer.result) : undefined;
  if (!figure) return new Response(null, { status: 404 });
  return new Response(figure.bytes, { headers: { "content-type": figure.type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
}
