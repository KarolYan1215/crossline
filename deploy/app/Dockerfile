# syntax=docker/dockerfile:1
# The full app for the hosted beta (docs/beta-launch.md §10.6): the web app, the worker and the server transcriber from one image, run as
# containers on the host's network so they reach each other and Caddy on 127.0.0.1 as they do on the owner's machine. Build from the
# repository root:
#
#   docker build -f deploy/app/Dockerfile -t crossline-app .
#
# BuildKit reads deploy/app/Dockerfile.dockerignore. The Codex binaries are not in the image: the host keeps upstream's Linux release
# (pinned by CODEX_LINUX_RELEASE_BINARY_SHA256) and mounts it read-only at /opt/codex. Since 2026-10-20 that is rust-v0.163.0:
# https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-unknown-linux-musl.tar.gz (asset sha256 beb339e8…,
# binary sha256 399ff69c…); the 0.155.0 binary stays accepted until /srv/crossline/codex is replaced (docs/codex-upgrade-0.163.md).
#
# Three build stages and a runtime (2026-10-22: the single-stage image was 5.3 GB and Hong Kong deploys stalled pulling it whole):
#   deps     production dependencies only, from the manifests and the lockfile, so its layer changes only when they do
#   builder  every dependency and the source; builds the web app and the worker
#   runtime  node, the runtime libraries, the deps layer, the source, and what the builder made — no compilers, no pnpm, no dev tools,
#            no pnpm store and no Next build cache. The layers a code change touches come last and are small (source, .next-prod, dist).
# Layout and paths are the same as before (/repo, /repo/node_modules/.bin/tsx, apps/worker/dist/*.mjs), so run.sh, ledger-sync.sh,
# backup.sh and the server.yml jobs that `docker run` this image with `tsx scripts/…` or `node -e` in packages/db work unchanged.

FROM node:22-bookworm-slim AS base
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
# A server far from deb.debian.org (the hosted beta's Hong Kong host) builds with `--build-arg APT_MIRROR=mirrors.aliyun.com`.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi

# Compilers for the native modules (node-gyp for better-sqlite3 and keytar when no prebuilt binary fits) and pnpm. Never shipped.
FROM base AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libsecret-1-dev ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0
WORKDIR /repo
# Every workspace manifest, including the ones not installed (assess, collector, launcher): a frozen install checks the lockfile against
# the whole workspace. apps/assess is its own image (apps/assess/Dockerfile); the collector and the launcher never run on the server.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/assess/package.json apps/assess/
COPY apps/collector/package.json apps/collector/
COPY apps/launcher/package.json apps/launcher/
COPY packages/auth/package.json packages/auth/
COPY packages/codex/package.json packages/codex/
COPY packages/connectors/package.json packages/connectors/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/identity-packs/package.json packages/identity-packs/
COPY packages/planner/package.json packages/planner/

FROM toolchain AS deps
# Production dependencies of the root (better-sqlite3, and tsx, which the server's one-off jobs run scripts with), web, worker and the
# packages. Peers recorded in the lockfile (next → @playwright/test, better-auth → vitest) still come along; nothing here loads them.
# Then what can never load on linux/x64 glibc is removed: musl builds of native packages (next's SWC, sharp, rolldown, lightningcss,
# which declare no libc for pnpm to filter on), onnxruntime-node's binaries for other systems (its linux/x64 one stays: the worker's
# Whisper transcription), and onnxruntime-web's browser files (@huggingface/transformers' Node build inlines what it uses and never
# requires the package). The manifests go last, so the stage holds node_modules trees only and the runtime copies them in one layer.
RUN pnpm install --prod --frozen-lockfile --filter '!@crossline/assess' --filter '!@crossline/collector' --filter '!@crossline/launcher' \
  && cd node_modules/.pnpm \
  && rm -rf ./*linuxmusl* ./*-musl@* \
     onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/darwin \
     onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/win32 \
     onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/linux/arm64 \
     onnxruntime-web@*/node_modules/onnxruntime-web/dist \
  && cd /repo && rm package.json pnpm-lock.yaml pnpm-workspace.yaml apps/*/package.json packages/*/package.json

FROM toolchain AS builder
RUN pnpm install --frozen-lockfile --filter '!@crossline/assess' --filter '!@crossline/collector' --filter '!@crossline/launcher'
COPY . .
# `private` headers (HSTS, CSP, frame and referrer policies) are fixed at build time, so the mode is set here as well as at run time.
# A 2 GB host builds with swap: a capped heap keeps Node from growing past what the kernel will page for it.
# The build also writes apps/web/public/sw.js (Serwist), which the runtime takes from here. Next's webpack cache (.next-prod/cache, about
# half a gigabyte) only speeds the next build and is dropped; at run time Next recreates the folder for its image cache.
RUN CROSSLINE_DEPLOYMENT_MODE=private NODE_OPTIONS=--max-old-space-size=2560 pnpm build:prod \
  && rm -rf apps/web/.next-prod/cache
# The worker as one prebuilt module run by plain node (scripts/build-worker.mjs): tsx compiling at start cost memory the 2 GB host lacks.
# It imports its packages by the absolute paths resolved here; the deps stage has the same paths (the lockfile names every directory),
# which the runtime stage checks.
RUN node scripts/build-worker.mjs

FROM base AS runtime
# libsecret is loaded by keytar at import, or every connector fails to load. ffmpeg decodes the recordings the server transcriber reads
# (apps/worker/src/sensevoice.ts), in blocks, so a long one never sits in memory whole, and the videos of saved notes (note-media.ts).
# No git or python3: the shell assistant that could use them never runs on the hosted beta (assistantAvailable), and every python3 in
# deploy/server and server.yml runs on the host.
RUN apt-get update && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data /state && chown node:node /data /state
WORKDIR /repo
COPY --from=deps /repo/ /repo/
# The server's own browser (2026-10-22, docs/skills-library.md 「托管版登录」): Playwright's Chromium headless shell, the build matching
# the playwright-core the worker imports (so its CDP protocol fits), with the libraries it needs. It is the login browser the person
# uses in a dialog on the page (remote-browser.ts) and the browser the readers of sites behind a login run headless on. WenQuanYi Micro
# Hei (about 5 MB) so a Chinese login page is not drawn as empty boxes. Before the source, so a code change does not download it again;
# about +300 MB on the 2.33 GB image.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN node "$(ls -d /repo/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core | head -1)/cli.js" install --with-deps --only-shell chromium \
  && apt-get install -y --no-install-recommends fonts-wqy-microhei \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /opt/ms-playwright
COPY . .
COPY --from=builder /repo/apps/web/public/ apps/web/public/
# Next writes its image cache under the build directory, so only that one is the app user's, as before.
COPY --from=builder --chown=node:node /repo/apps/web/.next-prod/ apps/web/.next-prod/
COPY --from=builder /repo/apps/worker/dist/ apps/worker/dist/
# Fail the build, not the deploy: every package the prebuilt worker and transcriber import by absolute path exists here, and the native
# modules load against the runtime's libraries (the builder had the -dev packages).
RUN set -e; \
  refs=$(grep -oh '"/repo/node_modules/[^"]*"' apps/worker/dist/index.mjs apps/worker/dist/transcriber.mjs | tr -d '"' | sort -u); \
  [ -n "$refs" ] || { echo "no absolute imports found in the worker bundle: has build-worker.mjs changed?"; exit 1; }; \
  for f in $refs; do [ -e "$f" ] || { echo "missing at run time: $f"; exit 1; }; done; \
  cd packages/db && node -e 'new (require("better-sqlite3"))(":memory:").close()'; \
  cd /repo/packages/connectors && node -e 'require(require.resolve("keytar", { paths: [require.resolve("@azure/msal-node-extensions")] }))'; \
  /repo/node_modules/.bin/tsx --version >/dev/null; ffmpeg -version | head -1; \
  cd /repo/apps/worker && node -e 'import("playwright-core").then(async ({ chromium }) => { const browser = await chromium.launch({ headless: true }); console.log("chromium", browser.version()); await browser.close(); })'
ENV NODE_ENV=production CROSSLINE_NEXT_DIR=.next-prod CROSSLINE_DATA_DIR=/data CROSSLINE_STATE_DIR=/state \
    CROSSLINE_CODEX_PATH=/opt/codex/codex CROSSLINE_DEPLOYMENT_MODE=private
USER node
VOLUME ["/data", "/state"]
# The binaries are started directly, not through `pnpm --filter … start` (the image has no pnpm since 2026-10-22; pnpm 12 also refused
# to run a script as `node` over an install made by root). The web app by default; run.sh starts the web through queue-server.mjs, the
# worker with `node dist/index.mjs` and the transcriber with `node dist/transcriber.mjs` in /repo/apps/worker.
WORKDIR /repo/apps/web
CMD ["node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", "3210"]
