# Unified Inbox Dashboard — Plan

One place to see email from every Gmail account and every hosting-provider mailbox
(cPanel, Hostinger, GoDaddy, Zoho, etc.), with Gemma (called through your existing
**OpenRouter** account) sorting each message by **importance** and **urgency**.

**Budget goal: as close to $0 as possible.** Everything runs on your own computer
(no server, no hosting bill). The only possible cost is OpenRouter, and the design below
keeps that at $0 (free Gemma) or a few cents per month (paid Gemma).

---

## 1. How it works (big picture)

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ Gmail acct 1 │   │ Gmail acct 2 │   │ you@domain   │  ... any number
 └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
        │ IMAP (SSL 993)   │                  │
        └──────────┬───────┴──────────────────┘
                   ▼
          ┌──────────────────┐
          │  Sync worker     │  every 2–5 min: fetch only NEW mail (by UID)
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │  Rules filter    │  cheap checks first: VIP senders, newsletters,
          └────────┬─────────┘  no-reply, OTP codes → skip or pre-score
                   ▼
          ┌──────────────────┐
          │ Gemma via        │  ONE request scores a batch of ~20 emails
          │ OpenRouter API   │  (sender + subject + first ~300 chars each)
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │  SQLite database │  messages + scores + your corrections
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │  Dashboard UI    │  localhost page / desktop window
          └──────────────────┘
```

The app runs on **your own computer**. Only short snippets (sender, subject, first few
hundred characters) of the emails that pass the rules filter are sent to OpenRouter.

---

## 2. Tech stack (recommended)

| Part | Choice | Why |
|---|---|---|
| Language | Python 3.11+ | Best email + AI libraries, easy to learn |
| Mail fetching | `imap-tools` (IMAP) | Same code works for Gmail **and** every hosting provider |
| Database | SQLite | One file, zero setup |
| AI model | Gemma via **OpenRouter** (OpenAI-compatible API) | You already have it; use the free `:free` Gemma variant, fall back to the paid one (fractions of a cent) |
| Backend | FastAPI | Small, fast, simple API for the UI |
| UI | HTML + HTMX (or Streamlit for a quick first prototype) | Opens in a browser at `http://localhost:8000` |
| Desktop window (optional) | `pywebview` | Makes it feel like an app instead of a browser tab, free |
| Secrets | OS keyring (`keyring` lib) | Passwords never stored in plain text |

---

## 3. Connecting the accounts

### Gmail accounts → IMAP + App Password (recommended for v1)
1. On each Gmail account turn on **2-Step Verification**.
2. Go to *Google Account → Security → App passwords*, create one called "Dashboard".
3. Make sure IMAP is enabled (Gmail Settings → Forwarding and POP/IMAP).
4. In the app: host `imap.gmail.com`, port `993`, your address, the 16-char app password.

> Why not the Gmail API? It's nicer (labels, push notifications), but for a personal,
> unverified Google Cloud app the login tokens for the `gmail.readonly` scope expire
> every **7 days** while the app is in "Testing" mode, and getting it verified is a long
> security review. IMAP + App Password just works and never expires. You can add the
> Gmail API later.

### Hosting accounts (cPanel / Hostinger / GoDaddy / Zoho / Namecheap ...)
Find the **IMAP settings** in your hosting panel (usually "Email Accounts → Connect
Devices"). Typically: host `mail.yourdomain.com`, port `993`, SSL, full email as username,
mailbox password.

All accounts end up in one `accounts` table — the app doesn't care which provider it is.

---

## 4. Database (SQLite)

```sql
accounts(id, label, email, imap_host, imap_port, color, last_uid, enabled)

messages(
  id, account_id, uid, message_id, thread_key,
  from_name, from_email, to_email, subject, snippet, body_text,
  received_at, is_read, has_attachments,
  -- AI results
  importance INT,      -- 1..5
  urgency INT,         -- 1..5
  category TEXT,       -- work, finance, client, personal, newsletter, promo, alert, otp...
  action_needed BOOL,
  deadline TEXT,       -- ISO date if the model found one
  summary TEXT,        -- one-line summary
  reason TEXT,         -- why the model scored it this way
  priority_score REAL, -- computed, used for sorting
  scored_by TEXT,      -- 'rule' | 'gemma' | 'user'
  UNIQUE(account_id, uid)
)

rules(id, type, pattern, importance, urgency, category)   -- e.g. VIP sender, block domain
feedback(message_id, old_importance, old_urgency, new_importance, new_urgency, at)
```

---

## 5. The AI sorting (the core feature)

### Step A — cheap rules first (saves time, no AI needed)
- Sender in your **VIP list** → importance 5.
- Has a `List-Unsubscribe` header or comes from known promo domains → newsletter/promo, importance 1.
- `noreply@` + words like "OTP", "verification code" → category `otp`, urgent but short-lived.
- Your own sent replies / auto-replies → skip.

Only what's left goes to Gemma (usually 20–40% of mail). Every email the rules
handle is an API call you don't pay for.

### Step B — Gemma prompt (batched, via OpenRouter)
Call `https://openrouter.ai/api/v1/chat/completions` with the `openai` Python package
(`base_url="https://openrouter.ai/api/v1"`, your OpenRouter key). Pick the model id from
openrouter.ai/models (search "gemma"; the free one ends in `:free`).

To keep it cheap, **send ~20 emails in one request**: for each, account label, sender,
subject, date and the first ~300 characters of plain text, plus 5 of your past
corrections as examples. Ask for a **JSON array**, one object per email id:

```json
{
  "importance": 4,
  "urgency": 5,
  "category": "client",
  "action_needed": true,
  "deadline": "2026-10-09",
  "summary": "Client asks for invoice fix before Friday",
  "reason": "Direct request from known client with a deadline in 2 days"
}
```

Set `response_format: {"type": "json_object"}` where the model supports it, and always
validate the JSON in code (re-ask once if it fails). Temperature ≈ 0 so the same email
gets the same score. Never re-score an email that already has a score.

### Step C — final priority score
```
priority = importance * 0.6 + urgency * 0.4
         + 1.0 if deadline within 48h
         + 0.5 if action_needed
         - 0.5 if already read
```
Sort the dashboard by `priority` (descending), then by date.

### Step D — learns from you
Every time you drag an email to a different bucket or change its score, save it in
`feedback`. The newest/most relevant corrections are fed back into the prompt as examples,
and repeated corrections for the same sender can auto-create a rule. No model training
needed.

---

## 6. The dashboard UI

- **Top bar:** account filter chips (each account its own color), search box, "sync now".
- **Main view — Eisenhower matrix (4 columns):**
  1. 🔴 Urgent + Important — do now
  2. 🟠 Important, not urgent — schedule
  3. 🟡 Urgent, not important — quick reply / delegate
  4. ⚪ Neither — newsletters, promos (collapsed by default)
- **List view toggle:** single list sorted by priority score.
- **Each card:** account color dot, sender, subject, AI one-line summary, deadline badge,
  "why?" tooltip showing the model's reason.
- **Click a card:** full email on the right side + "Open in Gmail / webmail" button.
- **Actions:** mark read, change priority (feedback), archive (optional, needs write access).

---

## 7. Build phases

| Phase | What you build | Done when |
|---|---|---|
| **0. Setup** (½ day) | Install Python, put your OpenRouter key in a `.env` file, create project folders | A 5-line test script gets a reply from Gemma |
| **1. Fetch** (1–2 days) | `accounts` config + IMAP sync script that saves new mail into SQLite | All accounts' last 200 emails are in the DB |
| **2. Basic dashboard** (1–2 days) | FastAPI + one page listing all emails, filter by account | You see every inbox in one list |
| **3. AI sorting** (2–3 days) | Rules filter + Gemma classifier running after each sync | Each email has importance/urgency/summary |
| **4. Priority views** (1–2 days) | Eisenhower matrix, priority list, "why?" reasons, deadline badges | Daily use is possible |
| **5. Feedback loop** (1 day) | Re-score buttons, `feedback` table, few-shot examples in prompt | Corrections change future scores |
| **6. Polish** (ongoing) | Background scheduler, desktop notification for priority ≥ 4.5, desktop window via pywebview, IMAP IDLE for instant mail, optional Gmail API | Feels like a real app |

---

## 8. Project layout

```
dashboard-for-all-gmails/
├── app/
│   ├── main.py           # FastAPI app + routes
│   ├── config.py         # settings, account list loader
│   ├── db.py             # SQLite setup + queries
│   ├── sync/
│   │   └── imap_sync.py  # fetch new mail per account
│   ├── ai/
│   │   ├── rules.py      # cheap pre-filters
│   │   ├── classifier.py # Gemma via OpenRouter (batched)
│   │   └── prompt.py     # prompt template + few-shot builder
│   ├── scheduler.py      # runs sync + classify every N minutes
│   └── templates/        # HTML (HTMX) pages
├── accounts.example.yaml # account list WITHOUT passwords
├── requirements.txt
└── PLAN.md
```

`requirements.txt` to start: `fastapi uvicorn imap-tools openai python-dotenv keyring apscheduler jinja2 pyyaml beautifulsoup4`

---

## 9. Cost (cheapest setup)

| Item | Cost |
|---|---|
| Hosting | **$0** — runs on your own PC at `localhost` |
| Gmail / hosting mailboxes via IMAP | **$0** |
| Python, FastAPI, SQLite, all libraries | **$0** |
| Gemma `:free` on OpenRouter | **$0**, but free models have daily request limits and can be slow/busy |
| Gemma paid on OpenRouter (fallback) | Rough math: 100 emails/day × ~300 tokens ≈ 1M tokens/month → **a few cents/month** |

How the app keeps the bill at (almost) zero:
1. **Rules first** — newsletters, promos, OTPs, VIPs never hit the API.
2. **Batching** — 20 emails per request, so 100 emails/day is ~5 requests/day; that fits
   comfortably inside free-tier daily limits.
3. **Short input** — only ~300 characters of body per email.
4. **Score once** — results saved in SQLite, never re-sent.
5. **New mail only** — on first run, score just the last ~7 days; older mail gets rules only.
6. **Fallback** — if the free model returns a rate-limit error (HTTP 429), wait and retry
   later, or switch to the paid Gemma id (set a tiny spend limit on your OpenRouter key).
7. **Cost guard** — the app counts requests per day and stops calling the API above a cap
   you set in `.env` (e.g. `MAX_AI_CALLS_PER_DAY=50`).

## 10. Security checklist

- App passwords stored in the OS keyring, never in the repo. `.env`, `accounts.yaml` and
  `*.db` go in `.gitignore`.
- Snippets of email go to OpenRouter and the model provider behind it. Turn off prompt
  logging/training in your OpenRouter privacy settings, and add a rule to never send mail
  from sensitive senders (bank, doctor) — score those by rules only.
- Server listens on `127.0.0.1` only — not reachable from your network.
- Read-only access first (no deleting/sending) until everything is trusted.
- Treat email text as untrusted input to the model: it only returns scores, it never
  takes actions based on what an email says.

---

## 11. Later ideas

- Draft replies with Gemma for "action needed" mail.
- Daily morning digest ("5 things that need you today").
- Thread grouping across accounts.
- Mobile access via Tailscale (private network) instead of exposing the app online.
