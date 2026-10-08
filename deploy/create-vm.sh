#!/usr/bin/env bash
# 1. On your Mac:  bash deploy/create-vm.sh --copy    (puts a one-line command on the clipboard)
# 2. In Google Cloud Shell (shell.cloud.google.com): paste it, press Enter, then run
#                  bash create-vm.sh tskey-auth-XXXX
# Creates the free e2-micro VM with exactly the free-tier settings and joins it to your
# Tailscale, so your Mac can finish the setup with: bash deploy/push-to-vm.sh --all
# Safe to run again: it picks up where it left off.
set -euo pipefail

if [ "${1:-}" = "--copy" ]; then
  # The whole script as one line, so a paste can't half-arrive; it says how many lines it saved.
  B64="$(gzip -9c "$0" | base64 | tr -d '\n')"
  printf '%s' "echo '$B64' | base64 -d | gunzip > create-vm.sh && echo \"Saved create-vm.sh (\$(wc -l < create-vm.sh) lines). Now run:  bash create-vm.sh tskey-auth-...\"" | pbcopy
  echo "Copied. In Cloud Shell: paste with Cmd+V and press Enter."
  echo "It should answer: Saved create-vm.sh ($(wc -l < "$0" | tr -d ' ') lines)."
  exit 0
fi

TSKEY="${1:-}"
NAME="${VM_NAME:-inbox}"
ZONE="${VM_ZONE:-us-central1-a}"     # free tier: us-central1, us-east1 or us-west1 only
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

case "$TSKEY" in
  tskey-auth-*) ;;
  *) echo "Usage: bash create-vm.sh tskey-auth-XXXX"
     echo "Make the key at https://login.tailscale.com/admin/settings/keys (Generate auth key, defaults are fine)."
     exit 1 ;;
esac

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ -z "$PROJECT" ]; then
  echo "No Google Cloud project selected. Your projects:"; gcloud projects list
  echo "Pick one with:  gcloud config set project PROJECT_ID   then run this again."; exit 1
fi
say "Project: $PROJECT"
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
if [ "$BILLING" = "False" ]; then
  echo "Billing isn't switched on for this project (Google needs it even for free-tier VMs)."
  echo "Open https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT , link your billing account, then run this again."
  exit 1
fi

say "Switching on the Compute Engine API (takes a minute the first time)"
gcloud services enable compute.googleapis.com

say "Safety alarm: an email if this project ever costs anything"
ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##' || true)"
if [ -z "$ACCOUNT" ]; then
  echo "couldn't read the billing account; set one by hand: Billing > Budgets & alerts > Create budget (1)"
elif gcloud billing budgets list --billing-account="$ACCOUNT" --format='value(displayName)' 2>/dev/null | grep -qx "inbox-vm-alarm"; then
  echo "already set"
else
  CUR="$(gcloud billing accounts describe "$ACCOUNT" --format='value(currencyCode)' 2>/dev/null || echo USD)"
  if gcloud services enable billingbudgets.googleapis.com >/dev/null 2>&1 &&
     gcloud billing budgets create --billing-account="$ACCOUNT" --display-name="inbox-vm-alarm" \
       --budget-amount="1${CUR:-USD}" --threshold-rule=percent=0.01 --threshold-rule=percent=1.0 >/dev/null 2>&1; then
    echo "set: you'll get an email at the first cent of cost"
  else
    echo "couldn't set it automatically; set one by hand: Billing > Budgets & alerts > Create budget (1)"
  fi
fi

# The VM reports to its serial console: "INBOX-SETUP: joined" or "INBOX-SETUP: failed".
reports() {
  gcloud compute instances get-serial-port-output "$NAME" --zone="$ZONE" 2>/dev/null |
    grep -o 'INBOX-SETUP: [a-z]*' | sed 's/INBOX-SETUP: //' || true
}
STATE="$(gcloud compute instances describe "$NAME" --zone="$ZONE" --format='value(status)' 2>/dev/null || true)"
BEFORE=0
if [ -z "$STATE" ]; then
  say "Creating the free VM '$NAME' (e2-micro, $ZONE, 30 GB standard disk, Debian 12)"
  STARTUP="$(mktemp)"
  cat > "$STARTUP" <<'BOOT'
#!/bin/bash
# Runs as root on every boot of the VM: a login user for your Mac, and Tailscale.
id inbox >/dev/null 2>&1 || {
  useradd -m -s /bin/bash inbox
  echo 'inbox ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/inbox && chmod 440 /etc/sudoers.d/inbox
}
for _ in $(seq 10); do   # first boot: apt may be busy with automatic updates for a while
  command -v tailscale >/dev/null && break
  curl -fsSL https://tailscale.com/install.sh | sh || sleep 30
done
for _ in $(seq 15); do   # after a reboot, give an already-joined Tailscale a moment to connect
  tailscale status >/dev/null 2>&1 && break
  sleep 2
done
if ! tailscale status >/dev/null 2>&1; then
  KEY="$(curl -sf -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/attributes/tailscale-authkey || true)"
  [ -n "$KEY" ] && tailscale up --authkey="$KEY" --ssh --hostname=inbox
fi
if tailscale status >/dev/null 2>&1; then echo "INBOX-SETUP: joined"; else echo "INBOX-SETUP: failed"; fi
BOOT
  gcloud compute instances create "$NAME" --zone="$ZONE" \
    --machine-type=e2-micro \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata-from-file=startup-script="$STARTUP" \
    --metadata=tailscale-authkey="$TSKEY"
  rm -f "$STARTUP"
elif [ "$(reports | tail -1)" = joined ]; then
  say "VM '$NAME' already exists and is in your Tailscale"
  echo "(it joined the Tailscale account its key was made in; your Mac must be signed in to that one)"
  BEFORE=-1
else
  say "VM '$NAME' already exists but isn't in your Tailscale yet: giving it the new key"
  BEFORE="$(reports | wc -l)"
  gcloud compute instances add-metadata "$NAME" --zone="$ZONE" --metadata=tailscale-authkey="$TSKEY"
  STARTED="$(gcloud compute instances describe "$NAME" --zone="$ZONE" --format='value(lastStartTimestamp)')"
  AGE=$(( $(date +%s) - $(date -d "${STARTED:-now}" +%s 2>/dev/null || date +%s) ))
  if [ "$STATE" != RUNNING ]; then
    echo "It was $STATE: starting it"
    gcloud compute instances start "$NAME" --zone="$ZONE"
  elif [ "$(reports | tail -1)" = failed ] || [ "$AGE" -gt 900 ]; then
    echo "Restarting it so it tries again with the new key"
    gcloud compute instances reset "$NAME" --zone="$ZONE"
  else
    echo "It's still setting itself up (started $((AGE / 60)) min ago) and will use the new key"
  fi
fi

if [ "$BEFORE" -ge 0 ]; then
  say "Waiting for the VM to join your Tailscale (usually 2-5 minutes, at most 10)"
  RESULT=""
  for _ in $(seq 120); do
    if [ "$(reports | wc -l)" -gt "$BEFORE" ]; then RESULT="$(reports | tail -1)"; break; fi
    sleep 5
  done
  if [ "$RESULT" = joined ]; then
    # the key was single-use; remove it from the VM's settings anyway
    gcloud compute instances remove-metadata "$NAME" --zone="$ZONE" --keys=tailscale-authkey >/dev/null 2>&1 || true
  elif [ "$RESULT" = failed ]; then
    gcloud compute instances remove-metadata "$NAME" --zone="$ZONE" --keys=tailscale-authkey >/dev/null 2>&1 || true
    echo "The VM couldn't join Tailscale. Its last messages:"
    gcloud compute instances get-serial-port-output "$NAME" --zone="$ZONE" 2>/dev/null |
      grep -i 'startup-script' | tail -15 || true
    echo
    echo "Usually the key was already used or has expired. Make a new one at"
    echo "https://login.tailscale.com/admin/settings/keys and run:  bash create-vm.sh tskey-auth-NEW-KEY"
    exit 1
  else
    echo "No word from the VM after 10 minutes; it may still be installing."
    echo "Wait 5 minutes and run the same command again (it picks up where it left off)."
    echo "Details:  gcloud compute instances get-serial-port-output $NAME --zone=$ZONE | grep startup-script | tail -40"
    exit 1
  fi
fi

say "Done: the VM is in your Tailscale as '$NAME'"
echo "One click in Tailscale so it never drops off: https://login.tailscale.com/admin/machines"
echo "  -> '$NAME' -> ... menu -> Disable key expiry"
echo
echo "Then, on your Mac, in the dashboard-for-all-gmails folder:"
echo
echo "    git pull && bash deploy/push-to-vm.sh --all"
