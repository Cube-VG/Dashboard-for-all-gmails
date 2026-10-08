# Run it 24/7 on a free cloud VM

**Setup:** Google Cloud's *Always Free* `e2-micro` VM (1 GB RAM, 30 GB disk), plus **Tailscale**, so only
your own Mac and iPhone can open the dashboard. Nothing is exposed to the internet
(unless you later choose the optional public login at the end of this guide).

**Cost:** $0, as long as you activate your Google account (step 2.1) and keep the settings marked ⚠️
below. OpenRouter costs the same as now.

**Why this setup:**
- **The app is tiny.** A few hundred emails, about 100 MB of RAM and well under 1 GB of disk, so the
  smallest free VM is enough.
- **Google's free VM is never shut down for being idle.** Oracle's free tier is the alternative, and it
  can reclaim idle machines.
- **Tailscale is free for personal use.** It gives the dashboard a private HTTPS address that works on
  your phone too.

Free-tier terms change. Check [cloud.google.com/free](https://cloud.google.com/free) when you sign up.

---

## 1. Tailscale (5 min)

1. Install **Tailscale** from the App Store on your Mac and your iPhone, and sign in on both with the
   same account.
2. In a browser, open [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns).
   Make sure **MagicDNS** is on, then click **Enable HTTPS** at the bottom.
3. Open [login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys)
   and click **Generate auth key…** → **Generate key**. The defaults are right: one use only, not
   reusable. Copy the key; it starts with `tskey-auth-`.

## 2. Create the VM (5 min, in your browser)

1. Sign up at [console.cloud.google.com](https://console.cloud.google.com).
   - Google asks for a card to verify you. The free VM doesn't charge it.
   - Make sure a project is selected at the top (new accounts get "My First Project").
   - ⚠️ **New accounts start on a 90-day free trial.** Open the console's
     [Welcome page](https://console.cloud.google.com/welcome), click **Activate** in its toolbar, then
     **Activate** again to confirm. (The [Billing page](https://console.cloud.google.com/billing) has the
     same button in its "Free credit" box.) Otherwise Google stops the VM when the trial ends and
     deletes it, with your mail, 30 days later. The `e2-micro` stays free after activating, and the
     budget alarm below emails you if anything ever costs money.
   - No **Activate** button? Either the account is already activated (nothing to do), or billing was
     never set up: open the [Billing page](https://console.cloud.google.com/billing), create a billing
     account, then come back here.
2. On your **Mac**, put the VM script on the clipboard as one line:
   ```
   cd ~/Documents/dashboard-for-all-gmails && git pull
   bash deploy/create-vm.sh --copy
   ```
3. Open **Cloud Shell** at [shell.cloud.google.com](https://shell.cloud.google.com). It's a free
   terminal in the browser.
4. Click inside the Cloud Shell terminal, paste with **Cmd+V** and press **Enter**.
   It must answer **`Saved create-vm.sh (… lines)`** with the number your Mac printed. If it doesn't,
   the paste didn't arrive: allow pasting if the browser asks, and try again.
5. Run it with your Tailscale key:
   ```
   bash create-vm.sh tskey-auth-PASTE-YOUR-KEY
   ```
   - If Cloud Shell asks to **Authorize**, click it.
   - It takes 3–10 minutes and ends with **Done**. Running it again is safe; it carries on
     from where it stopped.

The script does all of this:

| Step | |
|---|---|
| ⚠️ Free-tier settings | `e2-micro` · a free US zone (it tries the next one if Google has none left) · 30 GB **standard** disk · Debian 12 |
| Budget alarm | Emails you at the first cent of cost, if Google allows it to be set automatically |
| Tailscale | Joins the VM to your Tailscale as **inbox** and lets your Mac log in to it |
| Clean-up | Removes the used key from the VM's settings |

6. When it says **Done**, open [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines).
   Click the name it printed (usually **inbox**) → **⋯** → **Disable key expiry**, so the VM never
   drops off your Tailscale.

## 3. Send everything from your Mac (5 min)

In Terminal on your Mac, with the Tailscale app connected:

```
cd ~/Documents/dashboard-for-all-gmails
bash deploy/push-to-vm.sh --all
```

This copies to the VM:
- the app
- `accounts.yaml`
- your mailbox passwords, read from your Mac's Keychain
- your OpenRouter key and AI settings
- your mail, with its scores, sender rules and corrections

It then installs and starts the app. Everything goes over Tailscale's encrypted connection, and
nothing secret is written to a file on your Mac.

- **At most once every 12 hours**, Tailscale prints a link to approve the login. Open it; the
  script carries on by itself.
- **If macOS asks** whether Python may read your Keychain, click **Allow**.

At the end it prints your address, like `https://inbox.tail1234.ts.net/`.

- **iPhone:** open it in Safari, then Share → **Add to Home Screen**.
- **Mac:** bookmark it.

Then **stop the app on your Mac** (Ctrl+C where `python -m app` runs). Otherwise both copies sync and
sort mail, and you pay OpenRouter twice.

## Everyday commands (on your Mac)

```
git pull && bash deploy/push-to-vm.sh       # update the VM to the latest version (keeps settings and mail)
bash deploy/push-to-vm.sh --settings        # after changing accounts, passwords or the AI key on the Mac
ssh inbox@inbox 'journalctl -u inbox -f'    # watch the VM's log (Ctrl+C to stop watching)
ssh inbox@inbox                             # a terminal on the VM (type exit to leave)
```

The first time `ssh` asks "Are you sure you want to continue connecting?", type `yes`. If it says it
can't resolve `inbox`, use the `ssh inbox@100.…` line that `push-to-vm.sh` printed at the end.

The app starts by itself when the VM boots and restarts itself if it ever crashes.

## If something goes wrong

| Problem | Fix |
|---|---|
| `bash create-vm.sh …` prints nothing at all | The file is empty because the paste didn't arrive. Redo step 2, points 2–4 |
| `create-vm.sh` says billing isn't on | Link a billing account to the project (the script prints the link), then run it again |
| `create-vm.sh` says "No word from the VM" or "couldn't join" | Run it again as it says; for "couldn't join", with a new key |
| `create-vm.sh` says no free e2-micro is available | Google is out of free VMs in every free zone for now. Wait an hour and run it again |
| `push-to-vm.sh` says it doesn't have a machine called `inbox` | Step 2 didn't finish with **Done**, or this Mac is signed in to a different Tailscale account. The message lists what your Mac can see |
| `push-to-vm.sh` says "This Mac can't look up that address" | In the Tailscale menu-bar app's settings, turn on **Use Tailscale DNS settings**; check MagicDNS is on at [admin/dns](https://login.tailscale.com/admin/dns) |
| `push-to-vm.sh` says inbox's login expired | [admin/machines](https://login.tailscale.com/admin/machines) → inbox → ⋯ → **Temporarily extend key**, then **Disable key expiry** |
| `push-to-vm.sh` says inbox is offline, even after a Reset | Make a new auth key; in Cloud Shell run `bash create-vm.sh --rejoin tskey-auth-NEW-KEY` |
| The dashboard stopped about 3 months after setup | The Google free trial ended. Click **Activate** on the console's [Welcome page](https://console.cloud.google.com/welcome) within 30 days, then start the VM: Compute Engine → VM instances → inbox → Start |
| ssh says the tailnet policy doesn't permit it | In Tailscale's **Access controls**, keep the default `"ssh"` rule (members may SSH to their own devices) |
| A mailbox shows ✗ after the push | Run `bash deploy/push-to-vm.sh --settings` again; for Gmail, check the App Password still exists |

**Manual alternative (no Mac):** clone the repo on the VM and run `bash deploy/setup-vm.sh`. It asks
for the key, accounts and passwords itself.

## Notes

- **Gmail may email you "new sign-in from Google Cloud".** That's the VM. App Passwords keep working.
- **Sending works from the VM.** Google Cloud blocks only port 25 (for running your own mail
  server); mail goes out through Gmail's and your host's servers on ports 465/587, which are open.
  After an update, `push-to-vm.sh --settings` prints receive ✓ send ✓ for every account.
- **Times on the VM** follow your Mac's time zone: `push-to-vm.sh` copies it over.
- **No pop-up notifications on the VM.** It has no screen. Ask for phone push notifications (ntfy)
  if you want them.
- **Staying free:** an activated (not trial) account, 1 VM, `e2-micro`, a US region, a *standard* disk
  ≤ 30 GB, and under 1 GB of outbound traffic a month. The dashboard over Tailscale uses a few MB.
  Downloading email doesn't count.

---

## Optional: sign in from any device (public login)

With only Tailscale, the dashboard opens just on your own devices, which is the safest setup.
If you also want to open it from computers where you can't install Tailscale, turn on the login
and make it public. Anyone can then *see* the sign-in page, so it's protected by:

- **a password** (stored only as a scrypt hash)
- **a 6-digit code** from an authenticator app (Apple Passwords, Google Authenticator), so a stolen
  password alone isn't enough
- **a lockout** after 10 wrong tries in 15 minutes
- **sessions** that end after 12 hours, or 30 days if you tick "keep me signed in"
- **no caching** of pages, so a shared computer's Back button can't show your mail

On the VM (from your Mac: `ssh inbox@inbox`):

```
cd ~/dashboard-for-all-gmails
.venv/bin/python -m app.cli set-login     # choose a password, add the code to your authenticator app
sudo systemctl restart inbox
bash deploy/go-public.sh                  # refuses unless the login is on; prints the public address
```

Undo it with `bash deploy/go-private.sh`, which makes it Tailscale-only again.

| If… | Run (on the VM) |
|---|---|
| you lose your phone or think someone got in | `.venv/bin/python -m app.cli logout-all`, then `set-login` again |
| you locked yourself out with wrong tries | `.venv/bin/python -m app.cli unlock-login` |
| you want to change the password | `.venv/bin/python -m app.cli set-login` (signs out every device) |

**On shared or public computers:**
- Leave "keep me signed in" unticked.
- Use ⋯ → **Log out** when you're done.
