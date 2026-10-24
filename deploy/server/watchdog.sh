#!/bin/sh
# Keeps the hosted services up (the owner, 2026-10-24: 「始终保持服务开启」). Docker's `--restart unless-stopped` brings a container
# back when its process exits; it does nothing for one that is still running but no longer answers, nor for one left stopped. Every
# minute this checks each service from the host, and restarts a container after three failed checks in a row (a slow minute under
# load is not a dead service — the red bar's false 「后台服务没有运行」 on 2026-10-24 was one slow answer):
#
#   assess            http://127.0.0.1:3340/
#   crossline-web     http://127.0.0.1:3210/api/health
#   crossline-worker  http://127.0.0.1:3211/v1/codex/status
#
# A stopped container is started at once. It never runs while a deploy holds /run/crossline-run.lock (run.sh), and a container started
# less than three minutes ago is left alone while it boots. Every action goes to /var/log/crossline-watchdog.log.
#
#   sudo sh /srv/crossline/watchdog.sh --install    installs the cron entry (every minute) and runs once
set -u
state=/run/crossline-watchdog
log=/var/log/crossline-watchdog.log

if [ "${1:-}" = "--install" ]; then
  printf '%s\n' "* * * * * root sh /srv/crossline/watchdog.sh >> $log 2>&1" > /etc/cron.d/crossline-watchdog
  chmod 644 /etc/cron.d/crossline-watchdog
  echo "watchdog installed (/etc/cron.d/crossline-watchdog)"
fi

# A deploy is running: it starts and stops the containers itself.
exec 9>/run/crossline-run.lock
flock -n 9 || exit 0
mkdir -p "$state"

now=$(date -u +%s)
say() { echo "$(date -u +%FT%TZ) $*"; }

check() {
  name=$1 url=$2
  docker inspect "$name" >/dev/null 2>&1 || return 0   # never deployed here (e.g. no transcriber): nothing to keep up
  running=$(docker inspect -f '{{.State.Running}}' "$name")
  if [ "$running" != true ]; then
    say "$name not running; starting"
    docker start "$name" >/dev/null && rm -f "$state/$name"
    return 0
  fi
  started=$(date -u -d "$(docker inspect -f '{{.State.StartedAt}}' "$name")" +%s 2>/dev/null || echo 0)
  [ $((now - started)) -lt 180 ] && { rm -f "$state/$name"; return 0; }
  if curl -fs -o /dev/null -m 10 "$url"; then
    rm -f "$state/$name"
    return 0
  fi
  misses=$(( $(cat "$state/$name" 2>/dev/null || echo 0) + 1 ))
  echo "$misses" > "$state/$name"
  say "$name did not answer $url ($misses in a row)"
  if [ "$misses" -ge 3 ]; then
    say "$name restarting"
    docker restart -t 20 "$name" >/dev/null && rm -f "$state/$name"
  fi
}

check assess http://127.0.0.1:3340/
check crossline-web http://127.0.0.1:3210/api/health
check crossline-worker http://127.0.0.1:3211/v1/codex/status
