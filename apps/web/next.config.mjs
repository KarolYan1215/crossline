import withSerwistInit from "@serwist/next";

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
    "@crossline/workflows"
  ],
  // Loopback-only (`local`) has never needed these — nothing outside this device can address the app at
  // all, so a browser enforcing them buys nothing. `private` is the first mode where a real network path
  // (the tailnet, via Tailscale Serve's HTTPS termination) reaches this app from another device, which is
  // exactly the boundary these headers exist to harden.
  async headers() {
    if (deploymentMode === "local") return [];
    // `default-src 'self'` alone also blocks the inline bootstrap scripts/styles Next.js itself injects
    // into every page for hydration — found by actually logging in under `private` mode rather than only
    // checking the header was present: React never hydrated (`Minified React error #412`), so the login
    // form's `onSubmit` handler never attached and the browser fell back to a native GET submission,
    // putting the password in the URL's query string in plain text. A per-request nonce is the strict
    // fix, but it requires every route to render dynamically (`docs: Content Security Policy` guide),
    // which would break `/offline`'s whole reason for existing — that page is precached by the service
    // worker specifically so it works with no live request to render it. This app has no user-generated
    // HTML and embeds no third-party script or style origin, so the actual protection this CSP buys is
    // `'self'` blocking any injected content from ever loading off-origin; explicitly allowing inline
    // execution for the app's own first-party scripts/styles does not give that up.
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "Content-Security-Policy", value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' blob: data:",
          // FullCalendar (the Plan A-lens and the Workbench timeline view) ships its own icon font as a
          // `data:` URI. With no `font-src` at all it fell back to `default-src 'self'`, which blocks
          // `data:` — found live, walking the Workbench timeline view on a phone-width viewport: the
          // prev/next toolbar buttons rendered as empty glyph boxes instead of arrows.
          "font-src 'self' data:",
          "worker-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'"
        ].join("; ") },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" }
      ]
    }];
  }
});
