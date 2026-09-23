import "server-only";
import { getAuth } from "../../../../lib/auth";

/**
 * Not guarded by `isCrossSiteWrite` — that check is documented (see `csrf-protection.test.ts`'s
 * exemption for this exact path) rather than silently missing. This route legitimately receives
 * cross-site requests: the Google OAuth callback is Google redirecting back with a query string, which
 * has no `Origin` header a browser controls the way a form POST does. Better Auth's own
 * `trustedOrigins`/state-parameter checks are the real boundary here, not the app's.
 *
 * `toNextJsHandler` (the documented Next.js integration point) turns out to just re-export the same
 * method-agnostic `auth.handler` five times — Better Auth reads the real HTTP method off the `Request`
 * itself — so this calls `getAuth().handler` directly instead of importing it for one indirection.
 * `getAuth()` runs per request, not once at module load: this file is imported while Next.js builds its
 * route table (including at `next build` time), and a missing `BETTER_AUTH_SECRET` should fail the
 * request that needs it, not every build that merely imports this file.
 */
function handler(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
export async function GET(request: Request): Promise<Response> { return handler(request); }
export async function POST(request: Request): Promise<Response> { return handler(request); }
export async function PATCH(request: Request): Promise<Response> { return handler(request); }
export async function PUT(request: Request): Promise<Response> { return handler(request); }
export async function DELETE(request: Request): Promise<Response> { return handler(request); }
