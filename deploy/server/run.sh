#!/bin/sh
# (Re)starts the hosted beta's three containers from the images on this host (docs/beta-launch.md §10.6).
#   sudo sh /srv/crossline/run.sh            all three
#   sudo sh /srv/crossline/run.sh assess     one of: assess, web, worker
# Images: built by .github/workflows/images.yml and pulled from ghcr.io (a 2 GB host cannot run `next build`). A private repository's
# packages need one `sudo docker login ghcr.io -u <github user>` with a token that has read:packages. CROSSLINE_LOCAL_IMAGES=1 uses the
# images build.sh made on this host instead.
set -e
want="${1:-all}"
registry="${CROSSLINE_REGISTRY:-ghcr.io/karolyan1215}"
tag="${CROSSLINE_TAG:-beta}"
if [ "${CROSSLINE_LOCAL_IMAGES:-}" = 1 ]; then
  assess_image=crossline-assess; app_image=crossline-app
else
  assess_image="$registry/crossline-assess:$tag"; app_image="$registry/crossline-app:$tag"
  if [ "$want" = all ] || [ "$want" = assess ]; then docker pull "$assess_image"; fi
  if [ "$want" != assess ]; then docker pull "$app_image"; fi
fi

start() {
  name="$1"; shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped "$@" >/dev/null
  echo "started $name"
}

if [ "$want" = all ] || [ "$want" = assess ]; then
  start assess --env-file /srv/assess/assess.env -v /srv/assess/data:/data -p 127.0.0.1:3340:3340 --memory 400m "$assess_image"
fi
# The web app and the worker share the host's network (they talk on 127.0.0.1, as on the owner's machine) and one data/state volume.
if [ "$want" = all ] || [ "$want" = web ]; then
  start crossline-web --network host --env-file /srv/crossline/app.env \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro \
    -w /repo/apps/web "$app_image" node_modules/.bin/next start --hostname 127.0.0.1 --port 3210
fi
if [ "$want" = all ] || [ "$want" = worker ]; then
  # The worker's heartbeat lock outlives a removed container and reads as fresh for 45 minutes, so the new worker would exit
  # (worker.already_running) and restart in a loop. The old container is removed first, so no other worker holds it.
  docker rm -f crossline-worker >/dev/null 2>&1 || true
  rm -f /srv/crossline/data/worker.lock
  start crossline-worker --network host --env-file /srv/crossline/app.env \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro \
    -w /repo/apps/worker "$app_image" /repo/node_modules/.bin/tsx src/index.ts
fi
