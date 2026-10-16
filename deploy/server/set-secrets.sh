#!/bin/bash
# Puts the owner's own secrets into the server's env files, typed at a hidden prompt so they never pass through anyone else.
#   sudo bash /srv/crossline/set-secrets.sh
# Press Enter at a prompt to leave that value as it is. Restart afterwards: sudo sh /srv/crossline/run.sh
set -e
APP=/srv/crossline/app.env
ASSESS=/srv/assess/assess.env

put() { # file key value
  local file="$1" key="$2" value="$3"
  if grep -q "^$key=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else echo "$key=$value" >> "$file"; fi
  chmod 600 "$file"
}

read -r -s -p "Resend API key (re_…): " resend; echo
if [ -n "$resend" ]; then put "$APP" CROSSLINE_SMTP_PASSWORD "$resend"; put "$ASSESS" ASSESS_SMTP_PASSWORD "$resend"; echo "  Resend key saved."; fi

read -r -s -p "Image API key for the test's figures (Volcengine Ark key): " flow; echo
if [ -n "$flow" ]; then put "$ASSESS" ASSESS_IMAGE_API_KEY "$flow"; echo "  Image key saved."; fi

read -r -s -p "Tavily API key for web search on models other than ChatGPT (tvly-…): " tavily; echo
if [ -n "$tavily" ]; then put "$APP" TAVILY_API_KEY "$tavily"; put "$APP" CROSSLINE_SEARCH_PROVIDER tavily; echo "  Tavily key saved."; fi

read -r -p "Your own email (always allowed to sign up; Enter to skip): " owner
if [ -n "$owner" ]; then put "$APP" CROSSLINE_SIGNUP_ALLOWLIST "$owner"; echo "  Owner email saved."; fi
echo "Done. Restart: sudo sh /srv/crossline/run.sh"
