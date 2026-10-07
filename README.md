# Dashboard for all Gmails

One place for every Gmail and hosting mailbox, sorted by importance and urgency with
Gemma (via OpenRouter). Full plan: [PLAN.md](PLAN.md).

**Status:** steps 0–1 done: setup and fetching mail into a local database.

## Setup (once)

1. Install Python 3.11 or newer, then in this folder:
   ```
   python -m venv .venv
   .venv\Scripts\activate          # Windows   (macOS/Linux: source .venv/bin/activate)
   pip install -r requirements.txt
   ```
2. Copy `.env.example` → `.env` and paste your OpenRouter key.
3. Copy `accounts.example.yaml` → `accounts.yaml` and list your mailboxes.
   - **Gmail:** turn on 2-Step Verification, create an *App Password*
     (Google Account → Security → App passwords) and make sure IMAP is enabled.
   - **Hosting mailboxes:** host is usually `mail.yourdomain.com`, port 993.
4. Save each password once (stored in your OS keyring, not in any file):
   ```
   python -m app.cli set-password you@gmail.com
   ```

## Use

```
python -m app.cli check      # can we log in to every account?
python -m app.cli test-ai    # does your OpenRouter key reach Gemma?
python -m app.cli sync       # fetch new mail (first run: last 14 days, max 300 per account)
python -m app.cli list       # show the newest mail from all accounts
```

Run `sync` as often as you like; it only downloads mail it hasn't seen.
It never marks mail as read or changes anything on the server.

## Tests

```
python -m pytest
```
