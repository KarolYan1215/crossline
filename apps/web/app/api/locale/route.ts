import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "../../../lib/i18n";
import { chosenLocale, writeLocale } from "@crossline/db";
import { resolveAccessContext } from "../../../lib/access-guard";
import { getStore } from "../../../lib/crossline";
import { isCrossSiteWrite } from "../../../lib/same-origin";

export const dynamic = "force-dynamic";

const YEAR = 365 * 24 * 60 * 60;

/** Signed in or not: the language this browser has chosen, and the account's (docs/i18n.md). */
export async function GET(request: Request) {
  const jar = await cookies();
  const cookie = jar.get(LOCALE_COOKIE)?.value;
  const access = await resolveAccessContext(request).catch(() => undefined);
  return Response.json({ ok: true, cookie: isLocale(cookie) ? cookie : null, account: access && "ctx" in access ? chosenLocale(getStore(), access.ctx.workspaceId) ?? null : null },
    { headers: { "cache-control": "no-store" } });
}

/** `{locale}`: switches this browser, and the account when signed in, so the worker's messages and new model output follow too. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { locale?: unknown };
  const locale = body.locale;
  if (!isLocale(locale)) return Response.json({ ok: false, code: "LOCALE_INVALID" }, { status: 400 });
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: YEAR, sameSite: "lax", httpOnly: false });
  const access = await resolveAccessContext(request).catch(() => undefined);
  if (access && "ctx" in access) writeLocale(getStore(), access.ctx.workspaceId, locale);
  return Response.json({ ok: true, locale });
}
