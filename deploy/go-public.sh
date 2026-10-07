#!/usr/bin/env bash
# Make the dashboard reachable from any browser (public HTTPS via Tailscale Funnel).
# Refuses unless the login with 2-step codes is on.   Undo with: bash deploy/go-private.sh
set -euo pipefail
cd "$(dirname "$0")/.."
has() { grep -Eq "^$1='?[^'[:space:]]" .env 2>/dev/null; }
if ! has DASHBOARD_PASSWORD_HASH || ! has DASHBOARD_TOTP_SECRET; then
  echo "Turn on the login first (password + authenticator code):"
  echo "    .venv/bin/python -m app.cli set-login && sudo systemctl restart inbox"
  exit 1
fi
sudo systemctl restart inbox   # make sure the running app has the login switched on
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/html' http://127.0.0.1:8000/)
if [ "$code" != "303" ]; then
  echo "The app is not asking for a login yet (got HTTP $code). Not going public."; exit 1
fi
# (the first time, Tailscale may print a link to allow Funnel for this machine: open it)
sudo tailscale funnel --bg --https=443 http://127.0.0.1:8000
NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo
echo "Public now. Sign in from any browser at:  https://$NAME/"
echo "Back to private (Tailscale devices only):  bash deploy/go-private.sh"
