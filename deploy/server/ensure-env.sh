#!/bin/sh
# Adds settings that are not secrets and that a newer release needs to the server's env files, without touching any value already there
# (docs/beta-launch.md §10.6). Run by every deploy before the containers restart; safe to run again.
#   sudo sh /srv/crossline/ensure-env.sh
set -e
ensure() { # file key value — only when the key is absent or empty; a value already there is never changed
  [ -f "$1" ] || return 0
  grep -q "^$2=." "$1" && return 0
  # A line with nothing after "=" counts as unset (the old check took "KEY=" as present and never filled it in).
  grep -v "^$2=" "$1" > "$1.tmp" || true
  echo "$2=$3" >> "$1.tmp" && mv "$1.tmp" "$1" && chmod 600 "$1"
  echo "  set $2 in $1"
}
drop() { # file key — removes a setting a decision has retired; reported once, a no-op afterwards
  [ -f "$1" ] || return 0
  grep -q "^$2=" "$1" || return 0
  grep -v "^$2=" "$1" > "$1.tmp" || true
  mv "$1.tmp" "$1" && chmod 600 "$1"
  echo "  removed $2 from $1"
}
# No sign-up cap and no daily ceiling on the test's figures (the owner's decision of 2026-10-17): each address's own figure limit
# bounds the cost instead. Both were written by an earlier make-env.sh.
drop /srv/crossline/app.env CROSSLINE_SIGNUP_CAP
# A list with no cap admits only the list (packages/auth): with the cap gone, the owner's own address that set-secrets.sh wrote there
# turned open sign-up into invitation only and refused everyone else (found 2026-10-17). Open sign-up carries no list.
drop /srv/crossline/app.env CROSSLINE_SIGNUP_ALLOWLIST
drop /srv/crossline/app.env CROSSLINE_SIGNUP_ALLOWLIST_FILE
drop /srv/assess/assess.env ASSESS_IMAGE_DAILY_LIMIT
# The figures are drawn with Volcengine Ark's Seedream, whose key set-secrets.sh asks for; without the provider named the test fell back
# to SiliconFlow's API with that Ark key, every draw failed and the result page kept the template (2026-10-16).
ensure /srv/assess/assess.env ASSESS_IMAGE_PROVIDER ark
ensure /srv/assess/assess.env ASSESS_IMAGE_MODEL doubao-seedream-5-0-pro-260628
# The test's 「你也许想做」 is written by DeepSeek V4 on SiliconFlow (decided 2026-10-16), whose key set-secrets.sh asks for; with no key
# the test keeps its written combinations and rules. A SiliconFlow account made on siliconflow.com answers at api.siliconflow.com instead.
ensure /srv/assess/assess.env ASSESS_TEXT_BASE_URL https://api.siliconflow.cn/v1
ensure /srv/assess/assess.env ASSESS_TEXT_MODEL deepseek-ai/DeepSeek-V4-Pro
# The app's portrait figure for accounts on another model is drawn with the same Ark key and Seedream model (decided 2026-10-16). The key
# is copied between the two files on this host only, never printed; an app key already set is left alone.
ensure /srv/crossline/app.env CROSSLINE_IMAGE_API_STYLE ark
ensure /srv/crossline/app.env CROSSLINE_IMAGE_MODEL doubao-seedream-5-0-pro-260628
if [ -f /srv/crossline/app.env ] && ! grep -q "^CROSSLINE_IMAGE_API_KEY=." /srv/crossline/app.env; then
  key=$(grep "^ASSESS_IMAGE_API_KEY=" /srv/assess/assess.env 2>/dev/null | cut -d= -f2-)
  if [ -n "$key" ]; then
    grep -v "^CROSSLINE_IMAGE_API_KEY=" /srv/crossline/app.env > /srv/crossline/app.env.tmp || true
    printf 'CROSSLINE_IMAGE_API_KEY=%s\n' "$key" >> /srv/crossline/app.env.tmp && mv /srv/crossline/app.env.tmp /srv/crossline/app.env && chmod 600 /srv/crossline/app.env
    echo "  app uses the test's Ark key for portrait figures"
  fi
  unset key
fi
