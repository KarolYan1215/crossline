import withSerwistInit from "@serwist/next";

const deploymentMode = process.env.CROSSLINE_DEPLOYMENT_MODE ?? "local";
if (deploymentMode !== "local") {
  throw new Error("CROSSLINE_EXTERNAL_DEPLOYMENT_BLOCKED: external exposure requires per-user OIDC, workspace authorization, and a private network boundary.");
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
  ]
});
