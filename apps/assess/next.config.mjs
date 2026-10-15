import path from "node:path";

// The public quick test (docs/assess-deploy.md, docs/beta-launch.md §1–§6): a small Node server of its own — results, invitations, pair
// cards, server-rendered posters and figures in its own SQLite file — built as a standalone bundle for one Linux VPS behind Caddy. It
// never reaches the private app's ledger or models, so the private app's `external` deployment stays blocked
// (`apps/web/next.config.mjs`); this is a different application.
const development = process.env.NODE_ENV === "development";

// Self only. Next injects inline bootstrap scripts and styles into every page (a per-request nonce would force every page dynamic), so
// those stay allowed; nothing is ever loaded from another origin. Development adds 'unsafe-eval' for webpack's hot reload.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

// Capability pages and the API are never indexed (W3C TAG, Good Practices for Capability URLs).
const noindex = ["/r/:path*", "/t/:path*", "/p/:path*", "/api/:path*"].map((source) => ({
  source, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }]
}));

export default {
  output: "standalone",
  // Trace from the monorepo root so `@crossline/core` and the pnpm store under the root `node_modules` land in the bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Files read from disk at run time (W3's poster fonts, W5's type templates) are not imports, so the tracer cannot see them. The
  // Dockerfile also copies both folders beside the standalone server.
  outputFileTracingIncludes: {
    "/api/**": ["./templates/**/*.png", "./fonts/**/*"]
  },
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  images: { unoptimized: true },
  transpilePackages: ["@crossline/core"],
  // Native modules, and satori (it loads its own .wasm from beside its file), stay plain `require`s at run time instead of being bundled.
  serverExternalPackages: ["better-sqlite3", "@resvg/resvg-js", "satori"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" }
        ]
      },
      ...noindex
    ];
  }
};
