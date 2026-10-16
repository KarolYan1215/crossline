import { isLocale, LOCALE_COOKIE } from "../../../lib/i18n";
import { crossSiteWrite, fail } from "../../../server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const YEAR = 365 * 24 * 60 * 60;

/**
 * POST /api/locale `{locale: "zh" | "en"}`: this browser's language for the quick test (docs/i18n.md), kept in the `crossline-locale`
 * cookie the private app uses too. Refused from another site like every other write here. The cookie holds nothing but the choice.
 */
export async function POST(request: Request): Promise<Response> {
  if (crossSiteWrite(request)) return fail("REJECTED");
  const body = await request.json().catch(() => ({})) as { locale?: unknown };
  if (!isLocale(body.locale)) return Response.json({ ok: false, code: "LOCALE_INVALID" }, { status: 400, headers: { "cache-control": "no-store" } });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json({ ok: true, locale: body.locale }, {
    headers: { "cache-control": "no-store", "set-cookie": `${LOCALE_COOKIE}=${body.locale}; Path=/; Max-Age=${YEAR}; SameSite=Lax${secure}` }
  });
}
