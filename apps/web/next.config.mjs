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
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        // `'self'` covers the tailnet origin itself; nothing here embeds third-party scripts/styles, so
        // there is no allowlist to maintain as the app grows.
        { key: "Content-Security-Policy", value: "default-src 'self'; frame-ancestors 'none'" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" }
      ]
    }];
  }
});
