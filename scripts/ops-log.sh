#!/usr/bin/env sh
# Reads the encrypted log of one run of .github/workflows/server.yml (the repository is public, so the job log itself shows nothing):
#   sh scripts/ops-log.sh <run id>      (no id: the newest run)
# The private key lives only on the owner's machine, in $CROSSLINE_OPS_GNUPG (default ~/.crossline-ops-gnupg); its public half is
# .github/ops-log-key.asc. A lost key is replaced by generating a new pair and committing the new public key.
set -e
home="${CROSSLINE_OPS_GNUPG:-$HOME/.crossline-ops-gnupg}"
repo="${CROSSLINE_REPO:-KarolYan1215/crossline}"
run="${1:-$(gh run list -R "$repo" --workflow server.yml -L 1 --json databaseId --jq '.[0].databaseId')}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
gh run download "$run" -R "$repo" -n "ops-log-$run" -D "$dir"
gpg --homedir "$home" --batch --quiet --decrypt "$dir/ops.log.gpg"
