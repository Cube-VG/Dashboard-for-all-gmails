#!/usr/bin/env bash
# One-command setup on a fresh Debian/Ubuntu VM (e.g. Google Cloud's free e2-micro).
# Run it from inside the cloned repo:   bash deploy/setup-vm.sh
# Safe to run again: every step checks what is already done.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Installing system packages (python, git, curl)"
sudo apt-get update -qq
sudo apt-get install -y -qq python3 python3-venv python3-pip git curl >/dev/null
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ needed"' \
  || { echo "This VM's Python is too old; use a Debian 12 or Ubuntu 24.04 image."; exit 1; }

# 1 GB RAM is plenty to run the app, but a little swap keeps pip installs from running out of memory.
if ! swapon --show | grep -q .; then
  say "Adding 1 GB of swap"
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

say "Installing the app's Python packages"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

say "Settings (.env)"
[ -f .env ] || cp .env.example .env
chmod 600 .env
setenv() {  # set KEY=value in .env, replacing an existing line (temp file private from the start)
  ( umask 077
    grep -v "^$1=" .env > .env.tmp || true
    echo "$1=$2" >> .env.tmp && mv .env.tmp .env && chmod 600 .env )
}
setenv PASSWORD_STORE env      # no Keychain on a server: passwords live in .env (chmod 600)
setenv NOTIFICATIONS 0         # no desktop here to show pop-ups
if grep -q '^OPENROUTER_API_KEY=sk-or-\.\.\.' .env || ! grep -q '^OPENROUTER_API_KEY=.' .env; then
  read -rsp "Paste your OpenRouter API key (hidden): " key; echo
  setenv OPENROUTER_API_KEY "$key"
fi

if [ ! -f accounts.yaml ]; then
  cp accounts.example.yaml accounts.yaml
  say "Now list your mailboxes"
  echo "Opening accounts.yaml in nano. Replace the examples with your accounts"
  echo "(same content as on your Mac), then save with Ctrl+O, Enter, and exit with Ctrl+X."
  read -rp "Press Enter to open the editor..." _
  nano accounts.yaml
fi

say "Saving each mailbox password (App Passwords for Gmail)"
for email in $(.venv/bin/python - <<'PY'
from app import config
for a in config.load_accounts():
    if not config.get_password(a.email):
        print(a.email)
PY
); do
  .venv/bin/python -m app.cli set-password "$email"
done
.venv/bin/python -m app.cli check

say "Installing Tailscale (private access from your phone and Mac)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
if ! tailscale status >/dev/null 2>&1; then
  echo "Open the link below and sign in with the SAME account you use on your Mac/iPhone:"
  sudo tailscale up
fi
TS_NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
setenv ALLOWED_HOSTS "$TS_NAME"

say "Running the dashboard as a service (starts on boot, restarts if it crashes)"
sudo tee /etc/systemd/system/inbox.service >/dev/null <<UNIT
[Unit]
Description=Unified inbox dashboard
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$REPO
Environment=PYTHONUNBUFFERED=1
Environment=MALLOC_ARENA_MAX=2
# the app needs ~100 MB; cap it so nothing can ever take the whole 1 GB VM down with it
MemoryMax=500M
ExecStart=$REPO/.venv/bin/python -m app --no-browser
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now inbox.service
sudo systemctl restart inbox.service

# Only devices in your tailnet can reach this, over HTTPS; nothing is open to the internet.
# (the first time, Tailscale may print a link to switch on HTTPS for your tailnet: open it)
sudo tailscale serve --bg --https=443 http://127.0.0.1:8000

say "Done"
echo "Open this on your Mac or iPhone (with the Tailscale app signed in):"
echo
echo "    https://$TS_NAME/"
echo
echo "Logs:    journalctl -u inbox -f"
echo "Update:  git pull && .venv/bin/pip install -q -r requirements.txt && sudo systemctl restart inbox"
