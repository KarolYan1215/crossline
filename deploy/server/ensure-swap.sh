#!/bin/sh
# Gives the 1.6 GB host a 2 GB swap file when it has none (2026-10-16): with no swap, an image pull beside a busy worker left the system
# itself without memory and the host stopped answering, Caddy and SSH included. The containers still may not swap (run.sh sets
# --memory-swap equal to --memory); this is a cushion for the system, so memory pressure makes it slow instead of frozen.
#   sudo sh /srv/crossline/ensure-swap.sh
set -e
if [ "$(swapon --noheadings --show=NAME | wc -l)" -gt 0 ]; then echo "  swap already on"; exit 0; fi
free_kb=$(df -Pk / | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt 6291456 ]; then echo "  not adding swap: under 6 GB free on /"; exit 0; fi
[ -f /swapfile ] || { fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048; }
chmod 600 /swapfile
mkswap /swapfile >/dev/null
swapon /swapfile
grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
# Swap only when memory is really short: the cushion, not a second memory.
sysctl -q vm.swappiness=10
grep -q "^vm.swappiness" /etc/sysctl.conf || echo "vm.swappiness=10" >> /etc/sysctl.conf
echo "  2 GB swap file added"
