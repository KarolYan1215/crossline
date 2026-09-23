import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));

/**
 * Every mutating route must refuse a forged `Origin` before it touches anything else.
 *
 * This is a discovery test, not a per-route one, because the bug it guards against was never "the
 * check is wrong" — `isCrossSiteWrite` itself was correct and well tested. The bug was that six of
 * fourteen mutating routes never called it at all, because nothing forced a route author to remember.
 * A per-route test only proves the routes someone thought to write a test for; this one imports every
 * `route.ts` under this directory and asserts the property structurally, so a fifteenth route added
 * next month fails this test on day one instead of shipping unguarded.
 *
 * Found by hand with curl and a forged `Origin: https://evil.example` header: `commands`,
 * `energy-observations`, `milestones`, `codex/account`, `plans/[id]/approve` and
 * `milestone-relations/decide` all accepted the write — one of them, `codex/account`, returned a live
 * OAuth `authUrl`, meaning a forged request could kick off a real sign-in against this board's account
 * from another site the person merely had open in another tab.
 */
const allModules = import.meta.glob("./**/route.ts", { eager: true }) as Record<string, Record<string, unknown>>;
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * `auth/[...all]` is the one deliberate exemption, not a gap the discovery missed. It is Better Auth's
 * own catch-all — the Google OAuth callback is Google redirecting back with no `Origin` header a
 * browser controls the way a form POST does, so `isCrossSiteWrite` would reject a legitimate callback.
 * Better Auth's own `trustedOrigins` check is the real boundary for this one path; see the comment on
 * `apps/web/app/api/auth/[...all]/route.ts`.
 */
const EXEMPT = ["./auth/[...all]/route.ts"];
const modules = Object.fromEntries(Object.entries(allModules).filter(([path]) => !EXEMPT.includes(path)));

const forgedRequest = (url: string, method: string) =>
  new Request(url, { method, headers: { origin: "https://evil.example", "content-type": "application/json" } });

// Every dynamic segment this API surface currently has is a single `[id]`. A route with a different
// shape would need this widened, and would fail loudly (TypeError, not a false pass) if it were not.
const context = { params: Promise.resolve({ id: "test-id" }) };

for (const [path, mod] of Object.entries(modules)) {
  for (const method of MUTATING) {
    const handler = mod[method] as ((...args: unknown[]) => Promise<Response>) | undefined;
    if (typeof handler !== "function") continue;
    test(`${path} ${method} refuses a forged Origin`, async () => {
      const response: Response = path.includes("[id]")
        ? await handler(forgedRequest(`http://localhost${path}`, method), context)
        : await handler(forgedRequest(`http://localhost${path}`, method));
      expect(response.status).toBe(403);
    });
  }
}

// A glob that matched nothing would make the loop above pass by running zero tests — silence that
// looks identical to success. This fails loudly instead if the glob pattern or the directory ever stop
// lining up.
test("the route discovery actually found mutating routes to check", () => {
  const mutatingRouteCount = Object.values(modules)
    .filter((mod) => MUTATING.some((method) => typeof mod[method] === "function")).length;
  expect(mutatingRouteCount).toBeGreaterThanOrEqual(14);
});
