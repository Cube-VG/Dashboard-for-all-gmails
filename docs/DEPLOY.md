# Run it 24/7 on a free cloud VM

**Setup:** Google Cloud's *Always Free* `e2-micro` VM (1 GB RAM, 30 GB disk), plus **Tailscale**, so only
your own Mac and iPhone can open the dashboard. Nothing is exposed to the internet
(unless you later choose the optional public login at the end of this guide).

**Cost:** $0, as long as you follow the settings marked ⚠️ below. OpenRouter costs the same as now.

**Why this setup:**
- **The app is tiny.** A few hundred emails, about 100 MB of RAM and well under 1 GB of disk, so the
  smallest free VM is enough.
- **Google's free VM is never shut down for being idle.** Oracle's free tier is the alternative, and it
  can reclaim idle machines.
- **Tailscale is free for personal use.** It gives the dashboard a private HTTPS address that works on
  your phone too.

Free-tier terms change. Check [cloud.google.com/free](https://cloud.google.com/free) when you sign up.

---

## 1. Tailscale on your Mac and iPhone (5 min)

1. Install Tailscale from the Mac App Store and the iPhone App Store.
2. Sign in on both with the same account, for example your Google account.

## 2. Create the free VM (10 min)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign up.
   - Google asks for a card to verify you. The free VM doesn't charge it.
2. ⚠️ Set a safety alarm: **Billing → Budgets & alerts → Create budget → $1**.
   - You'll get an email if anything ever costs money.
3. Go to **Compute Engine → VM instances → Create instance**.
   - The first time, click **Enable** for the Compute Engine API.
4. Fill in the form:

   | Setting | Value |
   |---|---|
   | Name | `inbox` |
   | ⚠️ Region | `us-central1` (Iowa), `us-east1` or `us-west1`. Only these are free. |
   | ⚠️ Machine type | **e2-micro** |
   | ⚠️ Boot disk | **Change** → Debian 12, disk type **Standard persistent disk** (not "Balanced"), 30 GB |
   | Firewall | leave HTTP/HTTPS **unticked** (Tailscale doesn't need them) |

5. Click **Create**.
6. When the VM is running, click **SSH** next to it. A terminal opens in your browser.

## 3. Install the app on the VM (10 min)

In the browser SSH window:

```
git clone https://github.com/cube-vg/dashboard-for-all-gmails.git
cd dashboard-for-all-gmails
git checkout claude/dreamy-wright-isuy3u
bash deploy/setup-vm.sh
```

- **Logging in to GitHub:** the repo is private, so `git clone` asks for your GitHub username and a
  **token** instead of your password.
  - Create the token at github.com → Settings → Developer settings → Fine-grained tokens.
  - Give it access to this repo only, with **Contents: Read-only**.

The script asks for these, in order:

1. **Your OpenRouter key.** Paste it; it stays hidden as you paste.
2. **Your mailboxes.** An editor opens.
   - On your Mac, run `cat accounts.yaml` in the project folder and copy what it prints.
   - Paste it into the editor, then save with **Ctrl+O**, **Enter**, and exit with **Ctrl+X**.
3. **Each mailbox password.** Use the same Gmail App Passwords as on your Mac, or create new ones.
   - On the VM they're stored in `.env`, which only your user can read.
4. **A Tailscale login link.** Open it and sign in with the same account as on your Mac and iPhone.
   - If it also prints a link to turn on HTTPS, open that too.

At the end the script prints your dashboard's address, for example `https://inbox.tail1234.ts.net/`.

- **iPhone:** open the address in Safari, then Share → **Add to Home Screen**.
- **Mac:** bookmark it.

Then **stop the app on your Mac** (Ctrl+C), so the two copies don't both sort mail and use your
OpenRouter credit twice.

The VM starts with a fresh database. It sorts the last 14 days again, which costs about 16 AI calls,
a fraction of a cent. Add your sender rules again on the VM.

## Everyday commands (in the VM's SSH window)

```
cd ~/dashboard-for-all-gmails
journalctl -u inbox -f                     # live log (Ctrl+C to stop watching)
sudo systemctl restart inbox               # restart the app
git pull && .venv/bin/pip install -q -r requirements.txt && sudo systemctl restart inbox   # update
.venv/bin/python -m app.cli check          # test the mailbox logins
```

The app starts by itself when the VM boots and restarts itself if it ever crashes.

## Notes

- **Gmail may email you "new sign-in from Google Cloud".** That's the VM. App Passwords keep working.
- **No pop-up notifications on the VM.** It has no screen. Ask for phone push notifications (ntfy)
  if you want them.
- **Staying free:** 1 VM, `e2-micro`, a US region, a *standard* disk ≤ 30 GB, and under 1 GB of outbound
  traffic a month. The dashboard over Tailscale uses a few MB. Downloading email doesn't count.

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

In the VM's SSH window:

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
