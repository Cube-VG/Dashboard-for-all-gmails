#!/usr/bin/env bash
# Run on your Mac, in the dashboard-for-all-gmails folder (with the Tailscale app connected).
#   bash deploy/push-to-vm.sh --all       first time: code + setup + accounts/passwords/AI key + your mail
#   bash deploy/push-to-vm.sh             later: update the VM to the code you have here
#   bash deploy/push-to-vm.sh --settings  re-send accounts, passwords and AI settings
#   bash deploy/push-to-vm.sh --data      re-send your mail, scores, rules and corrections
# Everything travels over Tailscale's encrypted connection; secrets are never written to disk here.
set -euo pipefail
cd "$(dirname "$0")/.."

VM_NAME="${VM_NAME:-inbox}"        # the VM's name in Tailscale (create-vm.sh calls it "inbox")
DIR="dashboard-for-all-gmails"     # folder in the VM user's home
SSH="${SSH:-ssh}"
SETTINGS=0; DATA=0
for arg in "$@"; do
  case "$arg" in
    --all) SETTINGS=1; DATA=1 ;;
    --settings) SETTINGS=1 ;;
    --data) DATA=1 ;;
    *) echo "Unknown option: $arg (use --all, --settings or --data)"; exit 1 ;;
  esac
done
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run() { $SSH -o StrictHostKeyChecking=accept-new "$VM" "$@"; }

say "Finding '$VM_NAME' in your Tailscale"
if [ -z "${VM:-}" ]; then
  VM="inbox@$VM_NAME"
  # Ask the Tailscale app for the VM's address, so this works even if the Mac can't look up names.
  STATUS=""
  for TS in /Applications/Tailscale.app/Contents/MacOS/Tailscale "$(command -v tailscale || true)"; do
    [ -n "$TS" ] && [ -x "$TS" ] || continue
    STATUS="$("$TS" status --json 2>/dev/null || true)"
    [ -n "$STATUS" ] && break
  done
  if IP="$(printf '%s' "$STATUS" | .venv/bin/python deploy/find_vm.py "$VM_NAME")"; then
    VM="inbox@$IP"
  elif [ $? = 1 ]; then
    exit 1          # find_vm.py said what's wrong
  fi                # else: couldn't ask the app; try the name
fi
echo "VM: $VM"

say "Connecting to $VM over Tailscale"
echo "(at most once every 12 hours, Tailscale prints a link to approve this login: open it, and it carries on)"
run true || {
  echo "Can't reach $VM. Check that the Tailscale app on this Mac is connected and that"
  echo "'$VM_NAME' shows as online at https://login.tailscale.com/admin/machines"
  exit 1
}

say "Copying the app"
TARFLAGS=()
tar --version 2>/dev/null | grep -q bsdtar && TARFLAGS+=(--no-mac-metadata)
COPYFILE_DISABLE=1 tar czf - ${TARFLAGS[@]+"${TARFLAGS[@]}"} --exclude=./.venv --exclude=./data --exclude=./.env \
  --exclude=./accounts.yaml --exclude='__pycache__' --exclude=./.pytest_cache . |
  run "mkdir -p ~/$DIR && tar xzf - -C ~/$DIR --warning=no-unknown-keyword"

say "Setting up the VM (packages, service, private HTTPS address)"
run "cd ~/$DIR && bash deploy/setup-vm.sh --from-mac"

if [ "$SETTINGS" = 1 ]; then
  say "Sending your accounts, mailbox passwords and AI settings"
  .venv/bin/python -m app.cli export-settings |
    run "cd ~/$DIR && .venv/bin/python -m app.cli import-settings"
fi

if [ "$DATA" = 1 ]; then
  if [ -f data/inbox.db ]; then
    say "Sending your mail, scores, rules and corrections"
    SNAP="$(mktemp -d)"; trap 'rm -rf "$SNAP"' EXIT
    # a consistent copy even while the app is running here
    .venv/bin/python -c "import sqlite3,sys; s=sqlite3.connect('data/inbox.db'); d=sqlite3.connect(sys.argv[1]); s.backup(d); d.close()" "$SNAP/inbox.db"
    run "sudo systemctl stop inbox; umask 077; mkdir -p ~/$DIR/data && cat > ~/$DIR/data/inbox.db.upload &&
         mv ~/$DIR/data/inbox.db.upload ~/$DIR/data/inbox.db && rm -f ~/$DIR/data/inbox.db-wal ~/$DIR/data/inbox.db-shm" \
      < "$SNAP/inbox.db"
  else
    echo "No data/inbox.db here; the VM will start with an empty inbox and sync it."
  fi
fi

say "Restarting the dashboard on the VM"
run "sudo systemctl restart inbox"
if [ "$SETTINGS" = 1 ]; then
  run "cd ~/$DIR && .venv/bin/python -m app.cli check"
fi
NAME="$(run "tailscale status --json" | .venv/bin/python -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

say "Done"
echo "Your dashboard:  https://$NAME/"
if ! .venv/bin/python -c 'import socket,sys; socket.getaddrinfo(sys.argv[1], 443)' "$NAME" 2>/dev/null; then
  echo
  echo "! This Mac can't look up that address yet, so the link won't open here. Fix it once:"
  echo "  1. https://login.tailscale.com/admin/dns : MagicDNS on, and HTTPS Certificates enabled"
  echo "  2. Tailscale menu-bar icon > Settings: turn on 'Use Tailscale DNS settings'"
fi
echo "(on iPhone: open it in Safari, then Share > Add to Home Screen)"
if [ "$SETTINGS" = 1 ] || [ "$DATA" = 1 ]; then
  echo
  echo "Stop the copy on this Mac now (Ctrl+C where 'python -m app' runs), so only the VM"
  echo "syncs and sorts mail: two copies would use your OpenRouter credit twice."
fi
echo "VM logs any time:  ssh $VM 'journalctl -u inbox -f'"
