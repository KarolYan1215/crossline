#!/bin/sh
# The server side of the owner's ledger sync (docs/ledger-sync.md). Run as root on the host; every step runs in a one-off container
# of the app image the web container uses, so the running app is never written by a different build.
#
#   ledger-sync.sh stamp <email>          one JSON line: the account's workspace, when the person last acted, when anything changed
#   ledger-sync.sh pack <email> <out.tgz> packs that workspace (online backup + materials/sources/portrait) for the owner's machine
#   ledger-sync.sh apply                  imports /tmp/crossline-transfer.tgz into the account the manifest names, replacing what is
#                                         there: stops the app, copies the ledger to /srv/crossline/backups, writes, starts the app
#   ledger-sync.sh preview                the same import without writing
#
# `[migrate]` / `[migrate-apply]` in .github/workflows/server.yml call preview / apply; scripts/ledger-sync.ts calls all four over SSH.
# Both copy it to /tmp/crossline-sync/ together with the three scripts it mounts.
set -e
data=/srv/crossline/data
image=$(docker inspect -f '{{.Config.Image}}' crossline-web)
# The scripts shipped beside this file (scripts/ledger-stamp.ts, migrate-workspace.ts, pack-for-server.ts) are mounted over the
# image's copies, so a sync does not wait for the image to be rebuilt after a change to them.
here=$(cd "$(dirname "$0")" && pwd)
mounts=""
for s in ledger-stamp.ts migrate-workspace.ts pack-for-server.ts; do [ -f "$here/$s" ] && mounts="$mounts -v $here/$s:/repo/scripts/$s:ro"; done
run() { docker run --rm --init -v $data:/data $mounts "$@"; }
tsx=/repo/node_modules/.bin/tsx

case "$1" in
  stamp)
    [ -n "$2" ] || { echo "usage: stamp <email>" >&2; exit 2; }
    run -w /repo "$image" $tsx scripts/ledger-stamp.ts --db /data/crossline.db --email "$2"
    ;;
  pack)
    [ -n "$2" ] && [ -n "$3" ] || { echo "usage: pack <email> <out.tgz>" >&2; exit 2; }
    ws=$(run -w /repo "$image" $tsx scripts/ledger-stamp.ts --db /data/crossline.db --email "$2" | python3 -c "import json,sys;print(json.load(sys.stdin)['workspaceId'])")
    outdir=$(dirname "$3"); mkdir -p "$outdir"
    # A pack left by an earlier run as root cannot be overwritten by the app's user in the container (2026-10-22: a 10-21 copy blocked it).
    rm -f "$3"
    run -v "$outdir":/out -w /repo "$image" $tsx scripts/pack-for-server.ts --data /data --workspace "$ws" --to-email "$2" --out /out/$(basename "$3")
    chown "$(stat -c %u:%g "$outdir")" "$3" 2>/dev/null || true
    ;;
  preview|apply)
    test -f /tmp/crossline-transfer.tgz || { echo "no /tmp/crossline-transfer.tgz uploaded"; exit 1; }
    dir=/srv/crossline/import; rm -rf $dir; mkdir -p $dir; tar -xzf /tmp/crossline-transfer.tgz -C $dir; chown -R 1000:1000 $dir
    m() { python3 -c "import json,sys;print(json.load(open('$dir/manifest.json'))[sys.argv[1]])" "$1"; }
    ws=$(m workspaceId); from=$(m fromData); email=$(m toEmail)
    echo "workspace $ws  from $from  to $email"
    migrate() {
      run -v $dir:/import -w /repo "$image" $tsx scripts/migrate-workspace.ts \
        --from-db /import/crossline.db --from-data "$from" --workspace "$ws" --to-db /data/crossline.db --to-data /data \
        --files /import/files --to-email "$email" --replace "$@"
    }
    if [ "$1" = preview ]; then migrate; exit 0; fi
    docker stop crossline-worker crossline-web
    rm -f $data/worker.lock
    stamp=$(date +%Y%m%d-%H%M%S); mkdir -p /srv/crossline/backups
    for f in crossline.db crossline.db-wal crossline.db-shm; do [ -f $data/$f ] && cp -a $data/$f /srv/crossline/backups/$f.$stamp; done
    echo "server ledger copied to /srv/crossline/backups/*.$stamp"
    # Fourteen days of these are enough; each is the whole ledger.
    find /srv/crossline/backups -name 'crossline.db*' -mtime +14 -delete 2>/dev/null || true
    status=0; migrate --apply || status=$?
    docker start crossline-web crossline-worker
    [ $status = 0 ] && rm -f /tmp/crossline-transfer.tgz
    exit $status
    ;;
  *)
    echo "usage: ledger-sync.sh stamp <email> | pack <email> <out.tgz> | preview | apply" >&2; exit 2
    ;;
esac
