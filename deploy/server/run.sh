#!/bin/sh
# (Re)starts the hosted beta's three containers from the images on this host (docs/beta-launch.md §10.6).
#   sudo sh /srv/crossline/run.sh            all three
#   sudo sh /srv/crossline/run.sh assess     one of: assess, web, worker
# Images: crossline-assess and crossline-app, built on this host from /srv/crossline/src (see build.sh).
set -e
want="${1:-all}"

start() {
  name="$1"; shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped "$@" >/dev/null
  echo "started $name"
}

if [ "$want" = all ] || [ "$want" = assess ]; then
  start assess --env-file /srv/assess/assess.env -v /srv/assess/data:/data -p 127.0.0.1:3340:3340 --memory 400m crossline-assess
fi
# The web app and the worker share the host's network (they talk on 127.0.0.1, as on the owner's machine) and one data/state volume.
if [ "$want" = all ] || [ "$want" = web ]; then
  start crossline-web --network host --env-file /srv/crossline/app.env \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro crossline-app
fi
if [ "$want" = all ] || [ "$want" = worker ]; then
  start crossline-worker --network host --env-file /srv/crossline/app.env \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro \
    crossline-app pnpm --filter @crossline/worker start
fi
