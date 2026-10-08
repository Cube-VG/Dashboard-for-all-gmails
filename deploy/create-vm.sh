#!/usr/bin/env bash
# Run in Google Cloud Shell (shell.cloud.google.com):   bash create-vm.sh tskey-auth-XXXX
# Creates the free e2-micro VM with exactly the free-tier settings and joins it to your
# Tailscale, so your Mac can finish the setup with: bash deploy/push-to-vm.sh --all
set -euo pipefail

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

if gcloud compute instances describe "$NAME" --zone="$ZONE" >/dev/null 2>&1; then
  say "VM '$NAME' already exists"
else
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
if ! tailscale status >/dev/null 2>&1; then
  KEY="$(curl -s -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/attributes/tailscale-authkey)"
  [ -n "$KEY" ] && tailscale up --authkey="$KEY" --ssh --hostname=inbox
fi
tailscale status >/dev/null 2>&1 && echo "INBOX-SETUP: joined Tailscale"
BOOT
  gcloud compute instances create "$NAME" --zone="$ZONE" \
    --machine-type=e2-micro \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata-from-file=startup-script="$STARTUP" \
    --metadata=tailscale-authkey="$TSKEY"
  rm -f "$STARTUP"
fi

say "Waiting for the VM to join your Tailscale (1-3 minutes)"
for _ in $(seq 60); do
  if gcloud compute instances get-serial-port-output "$NAME" --zone="$ZONE" 2>/dev/null |
       grep -q "INBOX-SETUP: joined Tailscale"; then
    JOINED=1; break
  fi
  sleep 5
done
# the key was single-use; remove it from the VM's settings anyway
gcloud compute instances remove-metadata "$NAME" --zone="$ZONE" --keys=tailscale-authkey >/dev/null 2>&1 || true

if [ "${JOINED:-0}" = 1 ]; then
  say "Done: the VM is in your Tailscale as 'inbox'"
  echo "One click in Tailscale so it never drops off: https://login.tailscale.com/admin/machines"
  echo "  -> 'inbox' -> ... menu -> Disable key expiry"
  echo
  echo "Then, on your Mac, in the dashboard-for-all-gmails folder:"
  echo
  echo "    git pull && bash deploy/push-to-vm.sh --all"
else
  echo "The VM didn't report joining Tailscale yet. Check the Machines page at"
  echo "https://login.tailscale.com/admin/machines . If 'inbox' isn't there after a few minutes, run:"
  echo "    gcloud compute instances get-serial-port-output $NAME --zone=$ZONE | tail -40"
  exit 1
fi
