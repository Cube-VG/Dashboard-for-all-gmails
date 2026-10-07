#!/usr/bin/env bash
# Stop public access; the dashboard stays reachable from your Tailscale devices only.
set -euo pipefail
sudo tailscale funnel --https=443 off || true
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000
if tailscale funnel status 2>/dev/null | grep -qi "funnel on"; then
  echo "Warning: Tailscale still reports Funnel on. Check: tailscale funnel status"; exit 1
fi
echo "Private again: only devices signed in to your Tailscale can open the dashboard."
