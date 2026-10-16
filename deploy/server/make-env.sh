#!/bin/sh
# Writes /srv/crossline/app.env and /srv/assess/assess.env once, with fresh server secrets (never overwrites an existing file).
# What only the owner holds — the SMTP password and the image API key — is left blank, to be filled with `sudo nano <file>`.
set -e
APP=/srv/crossline/app.env
ASSESS=/srv/assess/assess.env
rand() { openssl rand -base64 "$1" | tr -d '\n'; }
link="$(rand 32)"

if [ ! -f "$APP" ]; then
  umask 077
  cat > "$APP" <<EOF
CROSSLINE_DEPLOYMENT_MODE=private
CROSSLINE_WEB_BASE_URL=https://app.crossline.lol
CROSSLINE_WEB_HEALTH_URL=http://127.0.0.1:3210/api/health
CROSSLINE_CODEX_SUPERVISOR_URL=http://127.0.0.1:3211
CROSSLINE_DATA_DIR=/data
CROSSLINE_STATE_DIR=/state
CROSSLINE_AI_OUTPUT_DIR=/data/ai-output
CROSSLINE_NEXT_DIR=.next-prod
CROSSLINE_CODEX_PATH=/opt/codex/codex
CROSSLINE_TIME_ZONE=Asia/Shanghai
CROSSLINE_AUTO_PUBLISH=off
BETTER_AUTH_SECRET=$(rand 48)
CROSSLINE_SUPERVISOR_CAPABILITY_SECRET=$(rand 48)
CROSSLINE_SECRET_KEY=$(rand 32)
# Who may create an account: anyone while there are fewer than CROSSLINE_SIGNUP_CAP accounts (people arrive by the public test or
# straight to the interview), the addresses listed here always; past the cap an address goes on the waiting list file.
CROSSLINE_PUBLIC_BETA=1
CROSSLINE_SIGNUP_CAP=30
CROSSLINE_SIGNUP_WAITLIST_FILE=/data/signup-waitlist.txt
CROSSLINE_SIGNUP_ALLOWLIST=
# Sign-in codes go out through this SMTP account (Resend: host smtp.resend.com, port 465, user resend, password = API key).
CROSSLINE_SMTP_HOST=smtp.resend.com
CROSSLINE_SMTP_PORT=465
CROSSLINE_SMTP_USER=resend
CROSSLINE_SMTP_PASSWORD=
CROSSLINE_SMTP_FROM=Crossline <noreply@mail.crossline.lol>
ASSESS_BASE_URL=https://test.crossline.lol
ASSESS_LINK_SECRET=$link
EOF
  echo "wrote $APP"
fi

if [ ! -f "$ASSESS" ]; then
  umask 077
  cat > "$ASSESS" <<EOF
ASSESS_BASE_URL=https://test.crossline.lol
ASSESS_LINK_SECRET=$link
ASSESS_APP_URL=https://app.crossline.lol
ASSESS_SMTP_HOST=smtp.resend.com
ASSESS_SMTP_PORT=465
ASSESS_SMTP_USER=resend
ASSESS_SMTP_PASSWORD=
ASSESS_MAIL_FROM=Crossline 测评 <noreply@mail.crossline.lol>
# SiliconFlow key for the personal figures; blank = every figure is its type's template.
ASSESS_IMAGE_PROVIDER=ark
ASSESS_IMAGE_MODEL=doubao-seedream-5-0-pro-260628
ASSESS_IMAGE_API_KEY=
ASSESS_IMAGE_DAILY_LIMIT=300
EOF
  echo "wrote $ASSESS"
fi
