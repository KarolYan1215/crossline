/**
 * The poster routes' responses. A poster carries a nickname and sits behind an unguessable link, so it is cached only by the viewer's
 * own browser, for five minutes (a redrawn figure shows up soon after), never indexed and never sends a referrer.
 */
const HEADERS = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };

export function pngResponse(png: Buffer): Response {
  return new Response(new Uint8Array(png), { status: 200, headers: { ...HEADERS, "Content-Type": "image/png", "Cache-Control": "private, max-age=300" } });
}

export function posterNotFound(): Response {
  return Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404, headers: { ...HEADERS, "Cache-Control": "no-store" } });
}
