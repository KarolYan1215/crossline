import { NextResponse, type NextRequest } from "next/server";
import { devicePrimaryUrl, staysLocal } from "./lib/device-mode";
import { contentSecurityPolicy, newNonce, sendsSecurityHeaders } from "./lib/csp";

/**
 * Device mode (docs/device-mode.md): when this install is linked as a device of a hosted account, its pages are the hosted site's — every
 * page goes there, path and query kept — except `/device` (the link and this machine's own switches), signing in to reach it, the API
 * routes and static files. Unlinked, nothing changes.
 *
 * Every page also gets its Content Security Policy here, with a nonce of its own (lib/csp.ts): on the request, where Next reads it to
 * mark its own scripts, and on the response.
 */
export function proxy(request: NextRequest) {
  const primary = devicePrimaryUrl();
  if (primary && !staysLocal(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, primary), 307);
  }
  if (!sendsSecurityHeaders()) return NextResponse.next();
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sw.js).*)"]
};
