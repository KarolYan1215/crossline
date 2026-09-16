import withSerwistInit from "@serwist/next";

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
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: [
    "@crossline/core",
    "@crossline/db",
    "@crossline/identity-packs",
    "@crossline/planner",
    "@crossline/workflows"
  ]
});
