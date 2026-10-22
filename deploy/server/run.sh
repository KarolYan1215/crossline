#!/bin/sh
# (Re)starts the hosted beta's three containers from the images on this host (docs/beta-launch.md §10.6).
#   sudo sh /srv/crossline/run.sh            all three
#   sudo sh /srv/crossline/run.sh assess     one of: assess, web, worker, transcriber
# Images: built by .github/workflows/images.yml and pulled from ghcr.io (a 2 GB host cannot run `next build`). A private repository's
# packages need one `sudo docker login ghcr.io -u <github user>` with a token that has read:packages. CROSSLINE_LOCAL_IMAGES=1 uses the
# images build.sh made on this host instead.
set -e
# One run at a time: two deploys overlapped on 2026-10-21, the second's pkill ended the first's app pull, the two pulls broke each
# other's containerd ingest, and both restarted everything on the old image.
exec 9>/run/crossline-run.lock
flock -w 3600 9 || { echo "another run.sh has held /run/crossline-run.lock for an hour"; exit 1; }
want="${1:-all}"
registry="${CROSSLINE_REGISTRY:-ghcr.io/karolyan1215}"
tag="${CROSSLINE_TAG:-beta}"
if [ "${CROSSLINE_LOCAL_IMAGES:-}" = 1 ]; then
  assess_image=crossline-assess; app_image=crossline-app
else
  assess_image="$registry/crossline-assess:$tag"; app_image="$registry/crossline-app:$tag"
  # The packages are private and the host keeps no registry login (a deploy logs in for its own pull and out again), so a restart by
  # hand cannot pull: it then runs the copy of the image already on this host instead of stopping (2026-10-16).
  # A pull that does not finish in 25 minutes is cut and started again once, keeping the layers it finished. A deploy (which logs in and
  # sets CROSSLINE_PULL_REQUIRED=1) retries any failed pull and, after three, fails instead of restarting on the old image unseen: the
  # first deploy with the fallback alone restarted everything on the old app image after a pull that ended in two seconds with no
  # message (2026-10-21). Before it, a pull left over from a cancelled deploy is stopped, and
  # stopped one-off containers and every image no running container uses are removed: a new app image (5.3 GB) is pulled whole beside
  # the running one when its base image changes, and on 2026-10-21 old images held 10 GB of the 40 GB disk, 5 GB was free and two
  # deploys hung on the same layer until the job's 20 minutes ran out.
  pkill -f "docker pull $registry/" 2>/dev/null || true
  docker container prune -f >/dev/null 2>&1 || true
  docker image prune -af 2>/dev/null | tail -1 || true
  required="${CROSSLINE_PULL_REQUIRED:-}"
  pull() {
    # 25 minutes a try, two tries: the limit is on the whole pull, not on silence, and a 5.3 GB app image pulled whole (its base changed)
    # took longer than eight minutes to extract on 2026-10-22, so three eight-minute tries cut the same extraction three times.
    for try in 1 2; do
      timeout 1500 docker pull "$1" && return 0 || code=$?
      if [ "$code" = 124 ]; then echo "pull of $1 did not finish in 25 minutes (try $try of 2)"
      elif [ "$required" = 1 ]; then echo "pull of $1 failed with exit $code (try $try of 2); $(df -h / | tail -1)"; sleep 10
      else break; fi
    done
    if [ "$code" = 124 ] || [ "$required" = 1 ]; then echo "pull of $1 did not finish; nothing restarted"; return 1; fi
    docker image inspect "$1" >/dev/null 2>&1 && echo "pull refused; using the copy of $1 already on this host"
  }
  echo "before pulling: $(df -h / | tail -1)"
  if [ "$want" = all ] || [ "$want" = assess ]; then pull "$assess_image"; fi
  if [ "$want" != assess ]; then pull "$app_image"; fi
fi

# Ceilings and how many things run at once follow the host's memory (the owner moved to a 3.5 GB host on 2026-10-17; 2 CPUs as before).
# The safeguards do not change with it: hard ceilings without swap, the worker's 75% high-water mark, queues that wait instead of
# refusing. Measured on the 1.6 GB host: a guest Codex process holds ~130 MB idle and more during a turn, the worker ~170 MB of its own,
# a page render up to ~70 MB, the test 168 MB with 25 people at once. Two CPUs bound the page renders more than memory does.
#   ≥ 3.2 GB: worker 1750m (5 model runs, 5 guest runtimes), web 650m (3 renders), assess 450m (3 posters) — 2.85 GB of the 3499 MB
#             MemTotal; idle, the system itself (docker, Caddy, the cloud agent) held ~590 MB, and it keeps an 8 GB swap file the containers
#             may not use. The fifth runtime was the owner's call on 2026-10-17; web gave back 50 MB (its renders peak near 330 MB)
#   below:    worker 550m (2, 2), web 400m (2), assess 300m (2) — 1.25 GB on the 1.6 GB host
host_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
# 录音在服务器转写 (docs/phone-recording.md 「服务器转写」): with CROSSLINE_SERVER_TRANSCRIBE=1 in app.env, on a host of 3.2 GB or more, a
# fourth container runs SenseVoice at night on one CPU. Measured on 2026-10-20: a 29-minute recording with 9 minutes of speech peaked at
# 557 MB (under tsx; the prebuilt process holds less), so it gets 650m — taken from the worker, which drops to 1350m with one model run and
# one guest runtime fewer, keeping the four ceilings 3.1 GB, under the 3149 MB the 350 MB rule allows.
transcribe=0
if grep -q "^CROSSLINE_SERVER_TRANSCRIBE=1" /srv/crossline/app.env 2>/dev/null && [ "${host_mb:-0}" -ge 3200 ]; then transcribe=1; fi
if [ "${host_mb:-0}" -ge 3200 ] && [ "$transcribe" = 1 ]; then
  # The transcriber holds SenseVoice and the speaker models together (~660 MB measured, 2026-10-21); the web gives it 100 MB (it peaks near 310).
  assess_mem=450m; assess_heap=320; web_mem=550m; web_heap=400; worker_mem=1350m; worker_heap=384; transcriber_mem=750m
  model_runs=4; guest_runtimes=4; web_renders=3; posters=3
elif [ "${host_mb:-0}" -ge 3200 ]; then
  assess_mem=450m; assess_heap=320; web_mem=650m; web_heap=480; worker_mem=1750m; worker_heap=384
  model_runs=5; guest_runtimes=5; web_renders=3; posters=3
else
  assess_mem=300m; assess_heap=224; web_mem=400m; web_heap=300; worker_mem=550m; worker_heap=280
  model_runs=2; guest_runtimes=2; web_renders=2; posters=2
fi
echo "host ${host_mb} MB: worker ${worker_mem}, web ${web_mem}, assess ${assess_mem}${transcriber_mem:+, transcriber $transcriber_mem}; ${model_runs} model runs, ${guest_runtimes} guest runtimes, ${web_renders} renders"
# A value set by hand in the env file wins over the profile: `-e` would override `--env-file`, so it is passed only when the file lacks it.
default_env() { # file key value
  grep -q "^$2=." "$1" 2>/dev/null || printf -- '-e %s=%s ' "$2" "$3"
}

start() {
  name="$1"; shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped "$@" >/dev/null
  echo "started $name"
}

if [ "$want" = all ] || [ "$want" = assess ]; then
  # The quick test is what many people use at once: the largest share after the worker, and a heap ceiling under it so a burst of
  # posters and figures is collected before the container is near its limit.
  start assess --env-file /srv/assess/assess.env -v /srv/assess/data:/data -p 127.0.0.1:3340:3340 --memory $assess_mem --memory-swap $assess_mem \
    $(default_env /srv/assess/assess.env ASSESS_RENDER_CONCURRENCY $posters) -e NODE_OPTIONS=--max-old-space-size=$assess_heap "$assess_image"
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
  start crossline-web --network host --env-file /srv/crossline/app.env --memory $web_mem --memory-swap $web_mem -e NODE_OPTIONS=--max-old-space-size=$web_heap \
    $(default_env /srv/crossline/app.env CROSSLINE_WEB_CONCURRENCY $web_renders) \
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
  start crossline-worker --network host --env-file /srv/crossline/app.env --memory $worker_mem --memory-swap $worker_mem -e NODE_OPTIONS=--max-old-space-size=$worker_heap \
    $(default_env /srv/crossline/app.env CROSSLINE_MODEL_CONCURRENCY $model_runs) $(default_env /srv/crossline/app.env CROSSLINE_GUEST_RUNTIMES $guest_runtimes) \
    -v /srv/crossline/data:/data -v /srv/crossline/state:/state -v /srv/crossline/codex:/opt/codex:ro \
    -w /repo/apps/worker "$app_image" $worker_cmd
fi
# The server transcriber (apps/worker/src/transcriber.ts): one CPU, no network, its own ceiling, the shared data volume (it writes transcripts into the
# ledger and deletes the uploads it has read) and the SenseVoice files read-only. The model is fetched once from Hugging Face
# (CROSSLINE_HF_BASE, e.g. https://hf-mirror.com, for a host that cannot reach it) and every file is checked against its pinned sha256;
# a file that does not match is deleted and the container is not started. Without CROSSLINE_SERVER_TRANSCRIBE=1 it is removed.
if [ "$want" = all ] || [ "$want" = transcriber ]; then
  if [ "$transcribe" = 1 ]; then
    models=/srv/crossline/models/sensevoice
    base="$(grep "^CROSSLINE_HF_BASE=" /srv/crossline/app.env 2>/dev/null | cut -d= -f2-)"
    base="${base:-https://huggingface.co}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
    mkdir -p "$models"
    ok=1
    for pair in "model.int8.onnx c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" "tokens.txt f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"; do
      file=${pair% *}; sum=${pair#* }
      if ! echo "$sum  $models/$file" | sha256sum -c --status 2>/dev/null; then
        curl -fsSL --retry 3 -o "$models/$file.tmp" "$base/$file" && mv "$models/$file.tmp" "$models/$file" || true
        if ! echo "$sum  $models/$file" | sha256sum -c --status 2>/dev/null; then echo "SenseVoice $file did not download or does not match its hash"; rm -f "$models/$file" "$models/$file.tmp"; ok=0; fi
      fi
    done
    # Speaker separation (apps/worker/src/diarize.ts): pyannote segmentation 3.0 and the 3D-Speaker CAM++ embedding. Optional — without
    # them the transcriber still runs, its lines just name no speaker.
    hf="$(grep "^CROSSLINE_HF_BASE=" /srv/crossline/app.env 2>/dev/null | cut -d= -f2-)"; hf="${hf:-https://huggingface.co}"
    speaker_model() {
      if ! echo "$2  $models/$1" | sha256sum -c --status 2>/dev/null; then
        curl -fsSL --retry 3 -o "$models/$1.tmp" "$hf/$3" && mv "$models/$1.tmp" "$models/$1" || true
        if ! echo "$2  $models/$1" | sha256sum -c --status 2>/dev/null; then echo "speaker model $1 did not download or does not match its hash"; rm -f "$models/$1" "$models/$1.tmp"; fi
      fi
    }
    speaker_model segmentation.int8.onnx d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.int8.onnx
    speaker_model speaker.onnx f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11 csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx
    chmod 644 "$models"/* 2>/dev/null || true
    if [ "$ok" = 1 ]; then
      transcriber_cmd="/repo/node_modules/.bin/tsx src/transcriber.ts"
      if docker run --rm --entrypoint test "$app_image" -f /repo/apps/worker/dist/transcriber.mjs; then transcriber_cmd="node dist/transcriber.mjs"; fi
      start crossline-transcriber --network none --env-file /srv/crossline/app.env --memory $transcriber_mem --memory-swap $transcriber_mem --cpus 1 \
        -e NODE_OPTIONS=--max-old-space-size=160 -e CROSSLINE_SENSEVOICE_DIR=/models -e CROSSLINE_TRANSCRIBE_THREADS=1 \
        -v /srv/crossline/data:/data -v "$models":/models:ro -w /repo/apps/worker "$app_image" $transcriber_cmd
    fi
  else
    docker rm -f crossline-transcriber >/dev/null 2>&1 && echo "removed crossline-transcriber" || true
  fi
fi
