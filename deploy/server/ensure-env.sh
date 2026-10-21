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
# 录音在服务器转写 (the owner's decision of 2026-10-20, docs/phone-recording.md): run.sh starts the transcriber container on a host of
# 3.2 GB or more; each person still turns it on in Settings, and uploads are refused until they do. Set it to 0 to take the container down.
ensure /srv/crossline/app.env CROSSLINE_SERVER_TRANSCRIBE 1
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
# Invite codes and the developer's model (the owner's decisions of 2026-10-18): applications are mailed to the owner, and accounts that
# redeemed a code run on SiliconFlow with the test's own SiliconFlow key, at most 30 yuan a month each. The candidates are tested by the
# worker and the cheapest that passes is used; prices are yuan per million tokens (input:output:context in K:cache-hit input), from
# SiliconFlow's price list. The key is copied between the two files on this host only, never printed.
ensure /srv/crossline/app.env CROSSLINE_INVITE_APPROVER karolyan1215@gmail.com
ensure /srv/crossline/app.env CROSSLINE_SPONSOR_BASE_URL https://api.siliconflow.cn/v1
# SiliconFlow serves DeepSeek V4.1 only as `DeepSeek-V4.1-Flash` (its /models, 2026-10-18): the first default named a model it does not have,
# so that exact default is replaced; a list set by hand is left alone.
if grep -q "^CROSSLINE_SPONSOR_MODELS=deepseek-ai/DeepSeek-V4.1=4:8:1024,zai-org/GLM-5.2=4:12:1024,deepseek-ai/DeepSeek-V4-Pro=4:8:1024$" /srv/crossline/app.env 2>/dev/null; then
  drop /srv/crossline/app.env CROSSLINE_SPONSOR_MODELS
fi
# SiliconFlow's listed prices (yuan per million tokens, input:output:context K:cache-hit input), 2026-10-18; DeepSeek-V4.1-Flash at its
# peak price (00–02 and 08–24 Beijing time). Replaces only the estimated list an earlier deploy wrote, never one set by hand.
if grep -q "^CROSSLINE_SPONSOR_MODELS=deepseek-ai/DeepSeek-V4.1-Flash=2:8:1024,zai-org/GLM-5.2=4:16:1024,zai-org/GLM-5.3=4:16:1024,deepseek-ai/DeepSeek-V4-Pro=4:16:1024$" /srv/crossline/app.env 2>/dev/null; then
  drop /srv/crossline/app.env CROSSLINE_SPONSOR_MODELS
fi
# Two cheaper candidates added at the owner's request (2026-10-18), named as the key's /models lists them; DeepSeek-V4-Flash at its peak price.
if grep -q "^CROSSLINE_SPONSOR_MODELS=deepseek-ai/DeepSeek-V4.1-Flash=2:8:1024:0.04,zai-org/GLM-5.2=8:28:1024:2,zai-org/GLM-5.3=8:28:1024:2,deepseek-ai/DeepSeek-V4-Pro=12:24:1024:1$" /srv/crossline/app.env 2>/dev/null; then
  drop /srv/crossline/app.env CROSSLINE_SPONSOR_MODELS
fi
# The frontier and five new candidates (the owner's decision of 2026-10-19). Measured on 2026-10-19, DeepSeek-V4-Flash, GLM-5.3, GLM-5.2
# and DeepSeek-V4-Pro passed everything as DeepSeek-V4.1-Flash did, but each cost more per run and was slower at p95: they are not measured
# again. The new ones are the catalogue's models whose listed prices could undercut V4.1-Flash; Qwen3.5 and the others are priced by their
# first input tier (a run's input stays under 128K), and they list no cache-hit price.
if grep -q "^CROSSLINE_SPONSOR_MODELS=deepseek-ai/DeepSeek-V4.1-Flash=2:8:1024:0.04,zai-org/GLM-5.2=8:28:1024:2,zai-org/GLM-5.3=8:28:1024:2,deepseek-ai/DeepSeek-V4-Pro=12:24:1024:1,zai-org/GLM-5.3-Flash=0.8:2.8:1024:0.23,deepseek-ai/DeepSeek-V4-Flash=3:9:1024:0.3$" /srv/crossline/app.env 2>/dev/null; then
  drop /srv/crossline/app.env CROSSLINE_SPONSOR_MODELS
fi
# The owner stopped the measurement of the last two on 2026-10-19 (Qwen3.5-27B at 31 of 45 runs, Step-3.5-Flash at 9 of 45 with three
# minutes a run; both behind GLM-5.3-Flash on pass rate, cost and p95 so far), and Ling-flash-2.0 had been stopped early: the list is the
# four measured whole.
if grep -q "^CROSSLINE_SPONSOR_MODELS=deepseek-ai/DeepSeek-V4.1-Flash=2:8:1024:0.04,zai-org/GLM-5.3-Flash=0.8:2.8:1024:0.23,Qwen/Qwen3.5-122B-A10B=0.8:6.4:262,Qwen/Qwen3.5-27B=0.6:4.8:262,Qwen/Qwen3.5-35B-A3B=0.4:3.2:262,stepfun-ai/Step-3.5-Flash=0.7:2.1:262,inclusionAI/Ling-flash-2.0=1:4:131$" /srv/crossline/app.env 2>/dev/null; then
  drop /srv/crossline/app.env CROSSLINE_SPONSOR_MODELS
fi
ensure /srv/crossline/app.env CROSSLINE_SPONSOR_MODELS "deepseek-ai/DeepSeek-V4.1-Flash=2:8:1024:0.04,zai-org/GLM-5.3-Flash=0.8:2.8:1024:0.23,Qwen/Qwen3.5-122B-A10B=0.8:6.4:262,Qwen/Qwen3.5-35B-A3B=0.4:3.2:262"
ensure /srv/crossline/app.env CROSSLINE_SPONSOR_MONTHLY_CNY 30
# The planning Skills (step planner, backplanner) on GLM-5.3-Flash: the owner's choice of 2026-10-20 after the real-work comparison.
ensure /srv/crossline/app.env CROSSLINE_SPONSOR_PLANNING_MODEL zai-org/GLM-5.3-Flash
# The main model held on V4.1-Flash while Qwen3.5-122B, which the automatic choice took on 2026-10-21, is compared on real work (the
# owner's decision the same day): served whenever its current record admits the required Skills, and never pruned.
ensure /srv/crossline/app.env CROSSLINE_SPONSOR_MAIN_MODEL deepseek-ai/DeepSeek-V4.1-Flash
if [ -f /srv/crossline/app.env ] && ! grep -q "^CROSSLINE_SPONSOR_API_KEY=." /srv/crossline/app.env; then
  key=$(grep "^ASSESS_TEXT_API_KEY=" /srv/assess/assess.env 2>/dev/null | cut -d= -f2-)
  if [ -n "$key" ]; then
    grep -v "^CROSSLINE_SPONSOR_API_KEY=" /srv/crossline/app.env > /srv/crossline/app.env.tmp || true
    printf 'CROSSLINE_SPONSOR_API_KEY=%s\n' "$key" >> /srv/crossline/app.env.tmp && mv /srv/crossline/app.env.tmp /srv/crossline/app.env && chmod 600 /srv/crossline/app.env
    echo "  app uses the test's SiliconFlow key for invited accounts"
  fi
  unset key
fi
