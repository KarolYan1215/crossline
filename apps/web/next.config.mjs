import withSerwistInit from "@serwist/next";
import { cspPolicy } from "./lib/csp-policy.mjs";

// Three states, not two: `local` (plain loopback, `pnpm dev`'s default) and `private` (this same app,
// still bound to loopback, reached from elsewhere on the tailnet only through `tailscale serve`'s own
// TLS-terminating reverse proxy — see docs/private-network-deployment.md) both stay allowed.
// `external` — real public internet exposure — is the one still blocked: per-user OIDC and workspace
// authorization exist now (stages two/three), but the other prerequisites `docs/external-deployment.md`
// lists have not all been demonstrated, and loosening this on a guess is not a decision to make quietly.
const deploymentMode = process.env.CROSSLINE_DEPLOYMENT_MODE ?? "local";
if (deploymentMode !== "local" && deploymentMode !== "private") {
  throw new Error("CROSSLINE_EXTERNAL_DEPLOYMENT_BLOCKED: public internet exposure has not cleared every prerequisite in docs/external-deployment.md.");
}

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  additionalPrecacheEntries: [{ url: "/", revision: "crossline-0.1.0" }]
});

export default withSerwist({
  reactStrictMode: true,
  distDir: process.env.CROSSLINE_NEXT_DIR ?? ".next",
  devIndicators: false,
  serverExternalPackages: ["better-sqlite3", "highs"],
  transpilePackages: [
    "@crossline/core",
    "@crossline/db",
    "@crossline/identity-packs",
    "@crossline/planner",
    "@crossline/workflows",
    "@crossline/i18n"
  ],
  // Views move in the page (app/ui/nav-link.tsx) and fetch the next one while the pointer rests on its link; a page fetched ahead is
  // kept 30 seconds for the click (`static` is what `prefetch={true}` and `router.prefetch` use). A page reached without a prefetch is
  // never kept (`dynamic` stays 0), and an action that reloads or refreshes the page drops them all.
  experimental: { staleTimes: { dynamic: 0, static: 30 } },
  async headers() {
    // Pages may be kept by the browser itself, never by anything shared: `private, no-cache` (revalidate before every use) in place of
    // Next's `no-store` for a dynamic page, which keeps a page out of Chromium's back/forward cache. (It did not keep Chrome from using a
    // page its Speculation Rules fetched ahead: both headers served the click from the prefetch, measured 2026-10-28, W-129.) Everything here is the person's own, hence `private`. The API keeps its own.
    const pages = { source: "/((?!api/|_next/|sw\\.js).*)", headers: [{ key: "Cache-Control", value: "private, no-cache" }] };
    // Loopback-only (`local`) has never needed the rest — nothing outside this device can address the app at all. `private` is the first
    // mode where a real network path (the tailnet through Tailscale Serve, the hosted beta behind Caddy) reaches this app.
    if (deploymentMode === "local") return [pages];
    return [pages, {
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" }
      ]
    },
    // Pages get their Content Security Policy per response, with a nonce (proxy.ts, lib/csp.ts). What else can be opened as a document —
    // an assistant's file served from the API — or runs as one — the service worker — gets the same policy with no inline script at all.
    // It used to be one static header for everything with `'unsafe-inline'` scripts, because Next's own bootstrap scripts are inline
    // (without it React never hydrated and the login form fell back to a GET with the password in the address); the nonce covers them now.
    ...["/api/:path*", "/sw.js"].map((source) => ({ source, headers: [{ key: "Content-Security-Policy", value: cspPolicy(undefined) }] }))];
  }
});
