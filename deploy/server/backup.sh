#!/bin/sh
# Daily backup of the hosted beta (decided 2026-10-17: until then the server's ledger, its logins and the test's results existed only on
# this one host, copied aside once before a migration).
#   sudo sh /srv/crossline/backup.sh             one backup now, into /srv/backups/<UTC stamp>/
#   sudo sh /srv/crossline/backup.sh --install   installs the daily cron entry (19:17 UTC = 03:17 in China) and makes one backup
#
# The three SQLite files are copied by SQLite's own online backup, in a one-off container of the app image, while the app keeps running:
# a plain `cp` of a WAL database under write can be torn. Each copy runs as the owner of its database (a copy made as root would leave
# root-owned -wal/-shm files the app's `node` user cannot open) and is checked with `PRAGMA integrity_check` before it counts.
# The files beside the ledger (materials, sources, portrait figures) go into one archive. Databases are kept 14 days, file archives 3.
# Off the host: the `backup` action of .github/workflows/server.yml downloads the newest one, encrypts it and keeps it as an artifact.
set -e
root=/srv/backups

if [ "${1:-}" = "--install" ]; then
  install -d -m 700 "$root"
  printf '%s\n' "17 19 * * * root sh /srv/crossline/backup.sh >> /var/log/crossline-backup.log 2>&1" > /etc/cron.d/crossline-backup
  chmod 644 /etc/cron.d/crossline-backup
  echo "daily backup installed (/etc/cron.d/crossline-backup)"
fi

image=$(docker inspect -f '{{.Config.Image}}' crossline-web 2>/dev/null || true)
[ -n "$image" ] || { echo "crossline-web is not running; nothing to back up from"; exit 1; }
stamp=$(date -u +%Y%m%d-%H%M)
out="$root/$stamp"
install -d -m 700 "$root"
mkdir -p "$out"

# copy <host dir> <file> — online backup of <host dir>/<file> into $out/<file>, then an integrity check of the copy.
copy() {
  [ -f "$1/$2" ] || { echo "  (no $1/$2)"; return 0; }
  owner=$(stat -c %u:%g "$1/$2")
  chown "$owner" "$out"
  docker run --rm --user "$owner" -v "$1":/src -v "$out":/out -w /repo/packages/db "$image" node -e '
    const Database = require("better-sqlite3");
    const [name] = process.argv.slice(1);
    (async () => {
      const source = new Database("/src/" + name, { fileMustExist: true });
      await source.backup("/out/" + name);
      source.close();
      const copy = new Database("/out/" + name, { readonly: true });
      const check = copy.pragma("integrity_check", { simple: true });
      copy.close();
      if (check !== "ok") { console.error("integrity_check: " + check); process.exit(1); }
    })().catch((error) => { console.error(error.message); process.exit(1); });' "$2"
  gzip -f "$out/$2"
  echo "  $2 $(du -h "$out/$2.gz" | cut -f1)"
}

echo "backup $stamp"
copy /srv/crossline/data crossline.db
copy /srv/crossline/data auth.db
copy /srv/assess/data assess.db
# Files the ledger points at. The assistant's scratch folders (ai-output), the databases themselves and uploaded recordings waiting to be
# transcribed (recordings/; their audio is deleted once transcribed and must never outlive it in a backup) are left out.
if [ -d /srv/crossline/data ]; then
  tar -czf "$out/files.tgz" -C /srv/crossline/data --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.bak' \
    --exclude='ai-output' --exclude='worker.lock' --exclude='import' --exclude='recordings' . 2>/dev/null || true
  echo "  files.tgz $(du -h "$out/files.tgz" | cut -f1)"
fi
chown -R root:root "$out"
chmod -R go-rwx "$out"
ln -sfn "$out" "$root/latest"

# Keep 14 days of databases and the newest three file archives.
find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
ls -1d "$root"/2* 2>/dev/null | sort -r | tail -n +4 | while read -r dir; do rm -f "$dir/files.tgz"; done
echo "done: $out"
