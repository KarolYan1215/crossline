#!/bin/sh
# Builds both images on the server from the source tarball (the upload from the owner's machine is too slow for multi-GB images).
#   sudo sh /srv/crossline/build.sh /tmp/src.tgz
set -e
src="${1:-/tmp/src.tgz}"
rm -rf /srv/crossline/src && mkdir -p /srv/crossline/src
tar -xzf "$src" -C /srv/crossline/src
cd /srv/crossline/src
docker build -f apps/assess/Dockerfile -t crossline-assess .
docker build -f deploy/app/Dockerfile -t crossline-app .
docker image prune -f >/dev/null
echo built
