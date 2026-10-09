"""The dashboard with made-up mail, for the browser tests. Never touches real mail or data/.

    python e2e/server.py PORT [--login]

- Sample mailbox: 10 emails in three accounts (two Gmail, one Hostinger).
- Sending goes to a fake mail server that only writes down what it was given, and the outbox
  worker runs, so Send, Undo and "Message sent" behave as they do for real.
- "Help me write" and "Sync now" answer with made-up results instead of calling OpenRouter/IMAP.
- --login: the dashboard asks for a password first ("correct horse").

The tests talk to it through /__test/* (outside the app, so it works with login on too):
    POST /__test/reset?data=demo|big   fresh mailbox (big: 1,500 emails, pages of 50)
    GET  /__test/sent                  what the fake mail server was given, oldest first
"""
import atexit
import json
import random
import shutil
import sys
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs

import uvicorn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app import config, db  # noqa: E402
from app.ai import drafts  # noqa: E402
from app.send import outbox  # noqa: E402
from app.web import auth  # noqa: E402
from app.web.main import create_app  # noqa: E402

PASSWORD = "correct horse"
WORK = Path(tempfile.mkdtemp(prefix="inbox-e2e-"))
atexit.register(shutil.rmtree, WORK, ignore_errors=True)
NOW = datetime.now(timezone.utc)

DEMO_ACCOUNTS = [
    config.Account(label="Personal", email="sam@gmail.com", imap_host="imap.gmail.com", color="#d93025", from_name="Sam Lee"),
    config.Account(label="Work", email="sam.work@gmail.com", imap_host="imap.gmail.com", color="#1a73e8"),
    config.Account(label="Velocity", email="sam@velocity.example", imap_host="imap.hostinger.com", color="#188038"),
]
BIG_ACCOUNTS = [
    config.Account(label="Personal", email="a@gmail.com", imap_host="imap.gmail.com", color="#d93025", from_name="Big Tester"),
    config.Account(label="Work", email="b@gmail.com", imap_host="imap.gmail.com", color="#1a73e8"),
    config.Account(label="Side", email="c@gmail.com", imap_host="imap.gmail.com", color="#f9ab00"),
    config.Account(label="Shop", email="d@shop.example", imap_host="imap.hostinger.com", color="#188038"),
]
# (account, name, from, subject, body, hours ago, read, (importance, urgency, category, summary, reason, deadline))
DEMO_MAIL = [
    ("sam.work@gmail.com", "Priya Raman", "priya@acme.example", "Contract renewal needs your signature today",
     "Hi Sam,\n\nThe renewal contract for Acme is attached. Legal needs it signed by 5 pm today so we can keep the current pricing.\n\nCould you sign and send it back?\n\nThanks,\nPriya",
     1, 0, (5, 5, "client", "Sign the Acme renewal contract by 5 pm today", "Client deadline today", "today")),
    ("sam@velocity.example", "Hostinger", "billing@hostinger.example", "Payment failed for velocity.example",
     "We couldn't charge your card for the hosting renewal. Update your payment method within 48 hours to avoid suspension.",
     2, 0, (5, 4, "finance", "Hosting payment failed; update card within 48 h", "Service suspension risk", None)),
    ("sam.work@gmail.com", "Dev Patel", "dev@acme.example", "Q4 planning doc — comments welcome",
     "Sharing the draft Q4 plan. Please add comments before next Thursday's review.",
     3, 1, (4, 2, "work", "Review the Q4 plan before Thursday", "Important, not urgent", None)),
    ("sam@gmail.com", "Mum", "mum@family.example", "Sunday lunch?",
     "Are you coming on Sunday? Let me know so I can cook enough!",
     5, 0, (4, 3, "personal", "Asks if you're coming to Sunday lunch", "Family, needs a reply this week", None)),
    ("sam@gmail.com", "HDFC Bank", "alerts@bank.example", "Your OTP is 482913",
     "482913 is your one-time password. Do not share it.",
     0.3, 0, (2, 5, "otp", "One-time code", "One-time code", None)),
    ("sam@velocity.example", "Alex Kim", "alex@client.example", "Quick question about the invoice",
     "Is the invoice for September including the extra design hours?",
     7, 0, (3, 4, "client", "Asks whether September invoice includes extra hours", "Short reply needed", None)),
    ("sam@gmail.com", "Medium Daily Digest", "noreply@medium.example", "Top stories for you",
     "10 stories picked for you this week.",
     9, 1, (1, 1, "newsletter", "Weekly reading digest", "Newsletter", None)),
    ("sam.work@gmail.com", "Figma", "no-reply@figma.example", "Your weekly team digest",
     "3 files were updated this week.",
     11, 1, (1, 2, "promo", "Team activity digest", "Automated digest", None)),
    ("sam@gmail.com", "Rahul", "rahul@friends.example", "Trip photos",
     "Uploaded the Goa photos to the shared album!", 13, 0, None),
    ("sam@velocity.example", "Stripe", "receipts@stripe.example", "Receipt from Velocity Growth",
     "Payment received: ₹12,400.", 15, 1, None),
]


def seed_demo(path: Path) -> None:
    c = db.connect(path)
    ids = {}
    for a in DEMO_ACCOUNTS:
        ids[a.email] = db.upsert_account(c, a.email, "INBOX", a.label, a.color)["id"]
        c.execute("UPDATE accounts SET last_synced_at = datetime('now', '-2 minutes') WHERE id = ?", (ids[a.email],))
    for n, (acct, name, frm, subj, body, hrs, read, score) in enumerate(DEMO_MAIL, 1):
        db.insert_messages(c, ids[acct], [{
            "uid": n, "message_id": f"<m{n}@demo>", "from_name": name, "from_email": frm, "to_email": acct,
            "subject": subj, "snippet": body.replace("\n", " ")[:300], "body_text": body,
            "received_at": (NOW - timedelta(hours=hrs)).isoformat(), "is_read": read,
            "has_attachments": int(n == 1), "list_unsubscribe": None}])
        mid = c.execute("SELECT id FROM messages WHERE message_id = ?", (f"<m{n}@demo>",)).fetchone()[0]
        if score:
            imp, urg, cat, summary, reason, deadline = score
            db.save_scores(c, mid, {"importance": imp, "urgency": urg, "category": cat, "summary": summary,
                                    "reason": reason, "action_needed": imp >= 3,
                                    "deadline": date.today().isoformat() if deadline else None},
                           "rule" if cat == "otp" else "gemma")
    c.execute("UPDATE messages SET answered_at = ? WHERE message_id = '<m3@demo>'", (NOW.isoformat(),))
    c.commit()
    c.close()


def seed_big(path: Path, n: int = 1500) -> None:
    """Every tab has more than one page: half Later, a quarter not sorted yet."""
    rnd = random.Random(7)
    c = db.connect(path)
    accts = [db.upsert_account(c, a.email, "INBOX", a.label, a.color)["id"] for a in BIG_ACCOUNTS]
    body = ("Hello, this is a longer email body with some details about the thing. " * 30)[:2000]
    rows = {a: [] for a in accts}
    for i in range(n):
        rows[accts[i % 4]].append({
            "uid": i + 1, "message_id": f"<big{i}@e2e>", "from_name": f"Sender {i % 97}",
            "from_email": f"s{i % 97}@corp{i % 13}.example", "to_email": BIG_ACCOUNTS[i % 4].email,
            "subject": f"Subject number {i} about something", "snippet": body[:300], "body_text": body,
            "received_at": (NOW - timedelta(minutes=37 * i)).isoformat(), "is_read": int(rnd.random() < 0.6),
            "has_attachments": int(rnd.random() < 0.1), "list_unsubscribe": None})
    for a, r in rows.items():
        db.insert_messages(c, a, r)
    for r in c.execute("SELECT id FROM messages ORDER BY id").fetchall():
        x = rnd.random()
        if x < 0.25:
            continue  # not sorted yet
        imp, urg = (5, 5) if x < 0.3 else (5, 2) if x < 0.4 else (2, 5) if x < 0.5 else (1, 1)
        db.save_scores(c, r["id"], {"importance": imp, "urgency": urg,
                                    "category": rnd.choice(["work", "newsletter", "promo", "personal", "finance"]),
                                    "summary": "A one-line summary of what this email wants", "reason": "because"},
                       "gemma")
    c.commit()
    c.close()


class Mailbox:
    """The database the app is using right now; a reset switches to a fresh copy."""

    def __init__(self):
        self.lock = threading.Lock()
        self.n = 0
        self.templates: dict[str, Path] = {}
        self.path: Path | None = None
        self.accounts = DEMO_ACCOUNTS
        self.sent: list[dict] = []

    def template(self, kind: str) -> Path:
        if kind not in self.templates:
            path = WORK / f"template-{kind}.db"
            (seed_big if kind == "big" else seed_demo)(path)
            c = db.connect(path)
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            c.close()
            self.templates[kind] = path
        return self.templates[kind]

    def reset(self, kind: str = "demo") -> None:
        with self.lock:
            self.n += 1
            path = WORK / f"run-{self.n}.db"
            shutil.copy(self.template(kind), path)
            old, self.path = self.path, path
            self.accounts = BIG_ACCOUNTS if kind == "big" else DEMO_ACCOUNTS
            self.sent = []
        if old is not None:
            for suffix in ("", "-wal", "-shm"):
                Path(str(old) + suffix).unlink(missing_ok=True)

    def connect(self):
        return db.connect(self.path)


box = Mailbox()
box.reset("demo")


def fake_smtp(acct, password, msg, rcpt):
    """Stands in for the mail server: writes down what would have gone out."""
    box.sent.append({"from": acct.email, "to": msg["To"], "cc": msg["Cc"], "rcpt": rcpt,
                     "subject": msg["Subject"], "in_reply_to": msg["In-Reply-To"],
                     "body": msg.get_content()})
    return {}


def outbox_worker():
    while True:
        try:
            outbox.process_due(box.connect, accounts=box.accounts, smtp=fake_smtp,
                               after=lambda *a, **k: [], get_password=lambda email: "pw")
        except Exception as exc:  # noqa: BLE001 - keep the worker alive, like the real one
            print("outbox worker:", exc, flush=True)
        time.sleep(0.5)


class FakeAI:
    """Answers "Help me write" like Gemma would, after a short think."""

    def __init__(self):
        self.chat = SimpleNamespace(completions=self)

    def create(self, model, messages, **kw):
        time.sleep(0.4)
        ask = messages[-1]["content"].lower()
        text = ("Hi,\n\nThanks for thinking of me, but I can't make it this time.\n\nBest,\nSam"
                if "decline" in ask else
                "Hi,\n\nThanks for your note. I've taken care of it and will follow up tomorrow.\n\nBest,\nSam")
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


drafts.make_client = FakeAI


def fake_sync():
    time.sleep(0.5)
    return {"sync": {"new": 0, "accounts": len(box.accounts)}}


def with_test_routes(app):
    """/__test/* is answered here, before the app (and its login check) sees the request."""
    async def asgi(scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/__test/"):
            q = parse_qs(scope.get("query_string", b"").decode())
            if scope["path"] == "/__test/reset":
                box.reset("big" if q.get("data") == ["big"] else "demo")
                body = {"ok": True, "db": str(box.path)}
            elif scope["path"] == "/__test/sent":
                body = box.sent
            else:
                body = {"error": "unknown"}
            data = json.dumps(body).encode()
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": data})
            return
        await app(scope, receive, send)
    return asgi


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    login = "--login" in sys.argv[2:]
    threading.Thread(target=outbox_worker, daemon=True).start()
    app = create_app(conn_factory=box.connect, accounts_loader=lambda: box.accounts, on_sync_now=fake_sync,
                     password_hash=auth.hash_password(PASSWORD) if login else "", totp_secret="")
    print(f"e2e server on http://127.0.0.1:{port}/ (login {'on' if login else 'off'})", flush=True)
    uvicorn.run(with_test_routes(app), host="127.0.0.1", port=port, log_level="warning")
