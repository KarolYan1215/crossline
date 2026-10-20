# syntax=docker/dockerfile:1
# The full app for the hosted beta (docs/beta-launch.md §10.6): the web app and the worker from one image, run as two containers on
# the host's network so they reach each other and Caddy on 127.0.0.1 as they do on the owner's machine. Build from the repository root:
#
#   docker build -f deploy/app/Dockerfile -t crossline-app .
#
# BuildKit reads deploy/app/Dockerfile.dockerignore. The Codex binaries are not in the image: the host keeps upstream's Linux release
# (pinned by CODEX_LINUX_RELEASE_BINARY_SHA256) and mounts it read-only at /opt/codex.
FROM node:22-bookworm-slim
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
# node-gyp for better-sqlite3 and keytar; libsecret is loaded by keytar at import, or every connector fails to load. ffmpeg decodes the
# recordings the server transcriber reads (apps/worker/src/sensevoice.ts), in blocks, so a long one never sits in memory whole.
# A server far from deb.debian.org (the hosted beta's Hong Kong host) builds with `--build-arg APT_MIRROR=mirrors.aliyun.com`.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s#deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libsecret-1-0 libsecret-1-dev ca-certificates git ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# `private` headers (HSTS, CSP, frame and referrer policies) are fixed at build time, so the mode is set here as well as at run time.
# A 2 GB host builds with swap: a capped heap keeps Node from growing past what the kernel will page for it.
RUN CROSSLINE_DEPLOYMENT_MODE=private NODE_OPTIONS=--max-old-space-size=2560 pnpm build:prod
# The worker as one prebuilt module run by plain node (scripts/build-worker.mjs): tsx compiling at start cost memory the 2 GB host lacks.
RUN node scripts/build-worker.mjs
RUN mkdir -p /data /state && chown -R node:node /data /state /repo/apps/web/.next-prod
ENV NODE_ENV=production CROSSLINE_NEXT_DIR=.next-prod CROSSLINE_DATA_DIR=/data CROSSLINE_STATE_DIR=/state \
    CROSSLINE_CODEX_PATH=/opt/codex/codex CROSSLINE_DEPLOYMENT_MODE=private
USER node
VOLUME ["/data", "/state"]
# The binaries are started directly, not through `pnpm --filter … start`: pnpm 12 checks the install before running a script and,
# finding it made by root, tries to remove node_modules as the `node` user and exits (ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR).
# The web app by default; the worker container runs `node dist/index.mjs` in /repo/apps/worker (deploy/server/run.sh).
WORKDIR /repo/apps/web
CMD ["node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", "3210"]
