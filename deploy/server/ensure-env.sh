#!/bin/sh
# Adds settings that are not secrets and that a newer release needs to the server's env files, without touching any value already there
# (docs/beta-launch.md §10.6). Run by every deploy before the containers restart; safe to run again.
#   sudo sh /srv/crossline/ensure-env.sh
set -e
ensure() { # file key value — only when the key is absent
  [ -f "$1" ] || return 0
  grep -q "^$2=" "$1" || { echo "$2=$3" >> "$1"; chmod 600 "$1"; echo "  added $2 to $1"; }
}
# The figures are drawn with Volcengine Ark's Seedream, whose key set-secrets.sh asks for; without the provider named the test fell back
# to SiliconFlow's API with that Ark key, every draw failed and the result page kept the template (2026-10-16).
ensure /srv/assess/assess.env ASSESS_IMAGE_PROVIDER ark
ensure /srv/assess/assess.env ASSESS_IMAGE_MODEL doubao-seedream-5-0-pro-260628
