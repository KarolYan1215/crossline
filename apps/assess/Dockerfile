# syntax=docker/dockerfile:1
# The public quick test as one container (docs/assess-deploy.md). Build from the repository root, so the workspace, the lockfile and
# @crossline/core are in the context:
#
#   docker build -f apps/assess/Dockerfile -t crossline-assess .
#
# BuildKit reads apps/assess/Dockerfile.dockerignore for this build (the repository has no root .dockerignore).

# Both stages use the same glibc image, so the native modules installed in the first (better-sqlite3's linux-x64 prebuild,
# @resvg/resvg-js-linux-x64-gnu) are the ones that load in the second.
FROM node:22-bookworm-slim AS build
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
# better-sqlite3's install step runs node-gyp, which needs Python and make even when it only finds the bundled linux-x64 prebuild and
# compiles nothing; g++ is there for an architecture without a prebuild.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0
WORKDIR /repo
COPY . .
# Only this app and what it depends on (@crossline/core), plus the workspace root for TypeScript, which `next build` type-checks with.
RUN pnpm install --frozen-lockfile --filter "@crossline/assess..." --filter "crossline"
RUN pnpm --filter @crossline/assess build
# The standalone server serves static assets only when they sit beside it (Next docs, `output: "standalone"`). The type templates and
# the poster fonts are read from disk at run time (relative to the server's directory), so they go beside it too.
RUN set -e; out=apps/assess/.next/standalone/apps/assess; \
    cp -r apps/assess/.next/static "$out/.next/static"; \
    for dir in public templates fonts; do if [ -d "apps/assess/$dir" ]; then rm -rf "$out/$dir"; cp -r "apps/assess/$dir" "$out/$dir"; fi; done

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3340 ASSESS_DATA_DIR=/data
WORKDIR /app
# The code stays root-owned and read-only to the server; only /data (the SQLite file and the drawn figures) is writable.
COPY --from=build /repo/apps/assess/.next/standalone ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3340
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3340/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/assess/server.js"]
