import { isLocale, requestLocale, type Locale } from "../../lib/i18n";

/**
 * The poster routes' responses. A poster carries a nickname and sits behind an unguessable link, so it is cached only by the viewer's
 * own browser, for five minutes (a redrawn figure shows up soon after), never indexed and never sends a referrer.
 */
const HEADERS = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };

export function pngResponse(png: Buffer): Response {
  // An address without `l=` follows the reader's cookie, so a cache must keep each language apart.
  return new Response(new Uint8Array(png), { status: 200, headers: { ...HEADERS, "Content-Type": "image/png", "Cache-Control": "private, max-age=300", Vary: "Cookie" } });
}

/** The reader's language for a poster: the address's `l=` (the views put it there), else the cookie, else Chinese. */
export function posterLocale(request: Request): Locale {
  const asked = new URL(request.url).searchParams.get("l");
  return isLocale(asked) ? asked : requestLocale(request);
}

export function posterNotFound(): Response {
  return Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404, headers: { ...HEADERS, "Cache-Control": "no-store" } });
}
