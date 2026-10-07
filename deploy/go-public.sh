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
# ask the running app itself: its login page must ask for the password AND the 6-digit code
page=""
for _ in $(seq 30); do
  page=$(curl -s http://127.0.0.1:8000/login || true)
  grep -q 'name="code"' <<<"$page" && break
  sleep 1
done
if ! grep -q 'name="code"' <<<"$page"; then
  echo "The app isn't asking for password + 6-digit code. Not going public."
  echo "Run: .venv/bin/python -m app.cli set-login && sudo systemctl restart inbox"
  exit 1
fi
# (the first time, Tailscale may print a link to allow Funnel for this machine: open it)
sudo tailscale funnel --bg --https=443 http://127.0.0.1:8000
NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo
echo "Public now. Sign in from any browser at:  https://$NAME/"
echo "Back to private (Tailscale devices only):  bash deploy/go-private.sh"
