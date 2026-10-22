import { NextResponse, type NextRequest } from "next/server";
import { devicePrimaryUrl, staysLocal } from "./lib/device-mode";

/**
 * Device mode (docs/device-mode.md): when this install is linked as a device of a hosted account, its pages are the hosted site's — every
 * page goes there, path and query kept — except `/device` (the link and this machine's own switches), signing in to reach it, the API
 * routes and static files. Unlinked, nothing changes.
 */
export function proxy(request: NextRequest) {
  const primary = devicePrimaryUrl();
  if (!primary || staysLocal(request.nextUrl.pathname)) return NextResponse.next();
  return NextResponse.redirect(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, primary), 307);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sw.js).*)"]
};
