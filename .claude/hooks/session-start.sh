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

# The hosted beta's deploy key (docs/beta-launch.md §10.6), when the owner put it in this environment's variables as one base64 line:
# written where the deploy commands look for it, readable by this session only. Nothing happens without the variable.
if [ -n "${CROSSLINE_DEPLOY_SSH_KEY_B64:-}" ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  printf '%s' "$CROSSLINE_DEPLOY_SSH_KEY_B64" | base64 -d > "$HOME/.ssh/crossline_hk"
  chmod 600 "$HOME/.ssh/crossline_hk"
fi

pnpm install
