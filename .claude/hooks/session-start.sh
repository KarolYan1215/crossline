#!/bin/bash
# Cloud sessions start from a fresh clone with no node_modules: install what `pnpm test` and `pnpm typecheck` need.
# Local machines manage their own install, so this does nothing outside a Claude Code cloud session.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR"

# better-sqlite3 has no prebuilt binary for this Node, and pnpm no longer bundles node-gyp to compile it.
if ! command -v node-gyp >/dev/null 2>&1; then
  npm install -g node-gyp
fi

# keytar (Graph token cache) loads libsecret at import time; without it every connector test fails to load.
if ! ldconfig -p 2>/dev/null | grep -q 'libsecret-1.so.0'; then
  apt-get update -qq && apt-get install -y -qq --no-install-recommends libsecret-1-0
fi

pnpm install
