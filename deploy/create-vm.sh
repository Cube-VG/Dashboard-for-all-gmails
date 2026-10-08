#!/usr/bin/env bash
# 1. On your Mac:  bash deploy/create-vm.sh --copy    (puts a one-line command on the clipboard)
# 2. In Google Cloud Shell (shell.cloud.google.com): paste it, press Enter, then run
#                  bash create-vm.sh tskey-auth-XXXX
# Creates the free e2-micro VM with exactly the free-tier settings and joins it to your
# Tailscale, so your Mac can finish the setup with: bash deploy/push-to-vm.sh --all
# Safe to run again: it picks up where it left off.
#                  bash create-vm.sh --rejoin tskey-auth-XXXX   restarts the VM so it joins Tailscale again
set -euo pipefail

if [ "${1:-}" = "--copy" ]; then
  # The whole script as one line, so a paste can't half-arrive; it says how many lines it saved.
  B64="$(gzip -9c "$0" | base64 | tr -d '\n')"
  printf '%s' "echo '$B64' | base64 -d | gunzip > create-vm.sh && echo \"Saved create-vm.sh (\$(wc -l < create-vm.sh) lines). Now run:  bash create-vm.sh tskey-auth-...\"" | pbcopy
  echo "Copied. In Cloud Shell: paste with Cmd+V and press Enter."
  echo "It should answer: Saved create-vm.sh ($(wc -l < "$0" | tr -d ' ') lines)."
  exit 0
fi

# gcloud must never stop to ask a question: its prompts can be hidden here and the script would hang.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

TSKEY=""; REJOIN=0
for arg in "$@"; do
  case "$arg" in
    --rejoin) REJOIN=1 ;;
    *) TSKEY="$arg" ;;
  esac
done
NAME="${VM_NAME:-inbox}"
FREE_ZONES="${VM_ZONE:-us-central1-a us-central1-b us-central1-c us-central1-f us-west1-b us-east1-b}"  # Always Free regions only
ATTEMPT="$(date +%s)-$RANDOM"   # the VM echoes this back, so we never mistake an old report for a new one
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

say "Switching on the Google APIs this needs (takes a minute the first time)"
gcloud services enable cloudbilling.googleapis.com >/dev/null 2>&1 || true
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
if [ "$BILLING" = "False" ]; then
  echo "Billing isn't switched on for this project (Google needs it even for free-tier VMs)."
  echo "Open https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT , link your billing account, then run this again."
  exit 1
fi
gcloud services enable compute.googleapis.com
gcloud services enable billingbudgets.googleapis.com >/dev/null 2>&1 || true

say "Safety alarm: an email if this project ever costs anything"
ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##' || true)"
if [ -z "$ACCOUNT" ]; then
  echo "couldn't read the billing account; set one by hand: Billing > Budgets & alerts > Create budget (1)"
elif gcloud billing budgets list --billing-account="$ACCOUNT" --format='value(displayName)' 2>/dev/null | grep -qx "inbox-vm-alarm"; then
  echo "already set"
else
  CUR="$(gcloud billing accounts describe "$ACCOUNT" --format='value(currencyCode)' 2>/dev/null || echo USD)"
  SET=0
  for _ in 1 2 3; do   # a just-switched-on API can take a moment to answer
    if gcloud billing budgets create --billing-account="$ACCOUNT" --display-name="inbox-vm-alarm" \
         --budget-amount="1${CUR:-USD}" --threshold-rule=percent=0.01 --threshold-rule=percent=1.0 >/dev/null 2>&1; then
      SET=1; break
    fi
    sleep 20
  done
  if [ "$SET" = 1 ]; then
    echo "set: you'll get an email at the first cent of cost"
  else
    echo "couldn't set it automatically; set one by hand: Billing > Budgets & alerts > Create budget (1)"
  fi
fi

STARTUP="$(mktemp)"; trap 'rm -f "$STARTUP"' EXIT
cat > "$STARTUP" <<'BOOT'
#!/bin/bash
# Runs as root on every boot of the VM: a login user for your Mac, and Tailscale.
# Reports "INBOX-SETUP: joined|failed name=... attempt=..." on the serial console for create-vm.sh.
md() { curl -sf -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
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
  KEY="$(md tailscale-authkey)"
  [ -n "$KEY" ] && tailscale up --reset --authkey="$KEY" --ssh --hostname=inbox
fi
if tailscale status >/dev/null 2>&1; then
  TSNAME="$(tailscale status --peers=false --json 2>/dev/null |
    sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
  echo "INBOX-SETUP: joined name=${TSNAME:--} attempt=$(md inbox-attempt)"
else
  echo "INBOX-SETUP: failed name=- attempt=$(md inbox-attempt)"
fi
BOOT

# This attempt's report from the VM (e.g. "joined name=inbox.tail1234.ts.net"), or the latest of any.
serial() { gcloud compute instances get-serial-port-output "$NAME" --zone="$ZONE" 2>/dev/null || true; }
report() {
  serial | grep -o "INBOX-SETUP: [a-z]* name=[A-Za-z0-9.-]* attempt=$1" | tail -1 |
    sed 's/^INBOX-SETUP: //; s/ attempt=.*//' || true
}

ZONE="$(gcloud compute instances list --format='value(name,zone.basename())' 2>/dev/null |
  awk -v n="$NAME" '$1 == n { print $2; exit }' || true)"
WAIT=1
if [ -z "$ZONE" ]; then
  for Z in $FREE_ZONES; do
    say "Creating the free VM '$NAME' (e2-micro, $Z, 30 GB standard disk, Debian 12)"
    if OUT="$(gcloud compute instances create "$NAME" --zone="$Z" \
        --machine-type=e2-micro \
        --image-family=debian-12 --image-project=debian-cloud \
        --boot-disk-size=30GB --boot-disk-type=pd-standard \
        --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
        --metadata-from-file=startup-script="$STARTUP" \
        --metadata=tailscale-authkey="$TSKEY",inbox-attempt="$ATTEMPT" 2>&1)"; then
      ZONE="$Z"; break
    fi
    if printf '%s' "$OUT" | grep -q 'ZONE_RESOURCE_POOL_EXHAUSTED\|does not have enough resources'; then
      echo "Google has no free e2-micro left in $Z right now; trying the next zone."
      continue
    fi
    printf '%s\n' "$OUT"; exit 1
  done
  if [ -z "$ZONE" ]; then
    echo "No free e2-micro is available in any free zone right now. Wait an hour and run this again."
    exit 1
  fi
else
  STATE="$(gcloud compute instances describe "$NAME" --zone="$ZONE" --format='value(status)')"
  LAST="$(serial | grep -o 'INBOX-SETUP: [a-z]*' | tail -1 | sed 's/^INBOX-SETUP: //' || true)"
  if [ "$REJOIN" = 0 ] && [ "$STATE" = RUNNING ] && [ "$LAST" = joined ]; then
    say "VM '$NAME' ($ZONE) already exists and joined your Tailscale when it last started"
    echo "(it joined the Tailscale account its key was made in; your Mac must be signed in to that one)"
    echo "If your Mac says it's offline or expired, follow what push-to-vm.sh says, or make it join"
    echo "again with a new key:  bash create-vm.sh --rejoin tskey-auth-NEW-KEY"
    gcloud compute instances remove-metadata "$NAME" --zone="$ZONE" --keys=tailscale-authkey >/dev/null 2>&1 || true
    WAIT=0
  else
    say "VM '$NAME' ($ZONE) already exists: giving it the new key"
    gcloud compute instances add-metadata "$NAME" --zone="$ZONE" --metadata-from-file=startup-script="$STARTUP" \
      --metadata=tailscale-authkey="$TSKEY",inbox-attempt="$ATTEMPT" >/dev/null
    STARTED="$(gcloud compute instances describe "$NAME" --zone="$ZONE" --format='value(lastStartTimestamp)')"
    AGE=$(( $(date +%s) - $(date -d "${STARTED:-now}" +%s 2>/dev/null || date +%s) ))
    if [ "$STATE" != RUNNING ]; then
      echo "It was $STATE: starting it"
      gcloud compute instances start "$NAME" --zone="$ZONE"
    elif [ "$REJOIN" = 1 ] || [ "$LAST" = failed ] || [ "$AGE" -gt 900 ]; then
      echo "Restarting it so it joins with the new key"
      gcloud compute instances reset "$NAME" --zone="$ZONE"
    else
      echo "It's still setting itself up (started $((AGE / 60)) min ago) and will use the new key"
    fi
  fi
fi

TSNAME="$NAME"
if [ "$WAIT" = 1 ]; then
  say "Waiting for the VM to join your Tailscale (usually 2-5 minutes, at most 10)"
  RESULT=""
  for _ in $(seq 120); do
    RESULT="$(report "$ATTEMPT")"
    [ -n "$RESULT" ] && break
    sleep 5
  done
  case "$RESULT" in
    joined*)
      N="${RESULT#*name=}"; [ "$N" = - ] || TSNAME="${N%%.*}"
      # the key was single-use; remove it from the VM's settings anyway
      gcloud compute instances remove-metadata "$NAME" --zone="$ZONE" --keys=tailscale-authkey >/dev/null 2>&1 || true ;;
    failed*)
      gcloud compute instances remove-metadata "$NAME" --zone="$ZONE" --keys=tailscale-authkey >/dev/null 2>&1 || true
      echo "The VM couldn't join Tailscale. Its last messages:"
      serial | grep -i 'startup-script' | tail -15 || true
      echo
      echo "Usually the key was already used or has expired. Make a new one at"
      echo "https://login.tailscale.com/admin/settings/keys and run:  bash create-vm.sh tskey-auth-NEW-KEY"
      exit 1 ;;
    *)
      echo "No word from the VM after 10 minutes; it may still be installing."
      echo "Wait 5 minutes and run the same command again (it picks up where it left off)."
      echo "Details:  gcloud compute instances get-serial-port-output $NAME --zone=$ZONE | grep startup-script | tail -40"
      exit 1 ;;
  esac
fi

say "Done: the VM is in your Tailscale as '$TSNAME'"
echo "Two one-time clicks, so it keeps running for good:"
echo "  1. Tailscale: https://login.tailscale.com/admin/machines -> '$TSNAME' -> ... -> Disable key expiry"
echo "  2. Google, if your account is on the free trial: click Activate (or Upgrade) in the banner at the"
echo "     top of https://console.cloud.google.com . Otherwise Google stops the VM when the 90-day trial"
echo "     ends. The e2-micro stays free after that, and the safety alarm emails you if anything costs money."
echo
echo "Then, on your Mac, in the dashboard-for-all-gmails folder:"
echo
echo "    git pull && bash deploy/push-to-vm.sh --all"
