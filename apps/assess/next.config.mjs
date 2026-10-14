// The public quick test (docs/assess-deploy.md): a static export with no server at all. Everything is computed in the browser from the
// pure scoring modules of @crossline/core (`@crossline/core/assess`, `@crossline/core/energy-rhythm`); it never reaches a ledger or a
// model, so it is safe to host apart from the private app, whose `external` deployment stays blocked.
export default {
  output: "export",
  reactStrictMode: true,
  trailingSlash: true,
  devIndicators: false,
  images: { unoptimized: true },
  transpilePackages: ["@crossline/core"]
};
