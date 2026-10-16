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
  # The packages are private and the host keeps no registry login (a deploy logs in for its own pull and out again), so a restart by
  # hand cannot pull: it then runs the copy of the image already on this host instead of stopping (2026-10-16).
  pull() { docker pull "$1" || { docker image inspect "$1" >/dev/null 2>&1 && echo "pull refused; using the copy of $1 already on this host"; }; }
  if [ "$want" = all ] || [ "$want" = assess ]; then pull "$assess_image"; fi
  if [ "$want" != assess ]; then pull "$app_image"; fi
fi

start() {
  name="$1"; shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped "$@" >/dev/null
  echo "started $name"
}

if [ "$want" = all ] || [ "$want" = assess ]; then
  # The quick test is what many people use at once: the largest share after the worker, and a heap ceiling under it so a burst of
  # posters and figures is collected before the container is near its limit.
  start assess --env-file /srv/assess/assess.env -v /srv/assess/data:/data -p 127.0.0.1:3340:3340 --memory 300m --memory-swap 300m \
    -e NODE_OPTIONS=--max-old-space-size=224 "$assess_image"
fi
# The web app and the worker share the host's network (they talk on 127.0.0.1, as on the owner's machine) and one data/state volume.
# Every container has a memory ceiling with no swap beyond it: on 2026-10-16 milestone design, a portrait rewrite and a figure ran at
# once with no ceiling, the host swapped until Caddy and SSH stopped answering, and both sites were down. Over its ceiling a container
# is killed and restarted by Docker instead (the worker's Codex runtimes are its children, so they count against the worker's).
# The ceilings add up to 1.25 GB on a host with 1.6 GB: the first ones (1.7 GB) left nothing for the system, and the next deploy's image
# pull froze the host again while the worker planned twenty milestones (2026-10-16). Keep their sum at least 350 MB under the host's.
# Measured on 2026-10-16 (scripts/load-assess.ts, scripts/load-app.ts): assess peaked at 168 MB with 25 people at once; ten people
# opening pages killed the web container twice at 280 MB, and the worker holds about 170 MB of its own once Codex threads are released.
if [ "$want" = all ] || [ "$want" = web ]; then
  # A Node heap ceiling under the container's: the heap is collected harder before the container is anywhere near being killed.
  # Through apps/web/queue-server.mjs when the image has it: page renders wait in line (four at a time) instead of all holding memory.
  web_cmd="node_modules/.bin/next start --hostname 127.0.0.1 --port 3210"
  if docker run --rm --entrypoint test "$app_image" -f /repo/apps/web/queue-server.mjs; then web_cmd="node queue-server.mjs --hostname 127.0.0.1 --port 3210"; fi
  start crossline-web --network host --env-file /srv/crossline/app.env --memory 400m --memory-swap 400m -e NODE_OPTIONS=--max-old-space-size=300 \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro \
    -w /repo/apps/web "$app_image" $web_cmd
fi
if [ "$want" = all ] || [ "$want" = worker ]; then
  # The worker's heartbeat lock outlives a removed container and reads as fresh for 45 minutes, so the new worker would exit
  # (worker.already_running) and restart in a loop. The old container is removed first, so no other worker holds it.
  docker rm -f crossline-worker >/dev/null 2>&1 || true
  rm -f /srv/crossline/data/worker.lock
  # The prebuilt worker (scripts/build-worker.mjs) when the image has it, else tsx as before. The Codex runtimes are its children and
  # live outside the Node heap, so the heap gets well under half the container.
  worker_cmd="/repo/node_modules/.bin/tsx src/index.ts"
  if docker run --rm --entrypoint test "$app_image" -f /repo/apps/worker/dist/index.mjs; then worker_cmd="node dist/index.mjs"; fi
  start crossline-worker --network host --env-file /srv/crossline/app.env --memory 550m --memory-swap 550m -e NODE_OPTIONS=--max-old-space-size=280 \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro \
    -w /repo/apps/worker "$app_image" $worker_cmd
fi
