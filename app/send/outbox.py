"""The outbox: mail you write waits UNDO_SECONDS (so Undo can stop it), then a background worker
sends it over the account's SMTP server.

status: queued -> sending -> sent | failed, or queued -> cancelled (Undo). Claiming a queued row
and cancelling it are both one conditional UPDATE, so Undo and the worker can never both win.
A row stuck in "sending" (the app stopped mid-send) is marked failed, never sent twice.
"""

import logging
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone

from app import config, db
from app.send import message as build
from app.send import transport

log = logging.getLogger(__name__)

UNDO_SECONDS = 10
STUCK_MINUTES = 5
KEEP_SENT_DAYS = 90
KEEP_UNDONE_DAYS = 14  # an undone email stays on the Sent page (to edit or discard) this long
WORKER_INTERVAL = 2.0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="seconds")


def queue(conn, *, account_email: str, mode: str, reply_to_id: int | None, to: str, cc: str,
          bcc: str, subject: str, body: str, include_quote: bool, full_text: str,
          in_reply_to: str | None, references: str | None, now: datetime | None = None,
          delay: float = UNDO_SECONDS) -> int:
    now = now or _now()
    cur = conn.execute(
        """INSERT INTO outbox (account_email, mode, reply_to_id, to_addrs, cc_addrs, bcc_addrs,
           subject, body, include_quote, full_text, in_reply_to, references_hdr, status,
           send_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)""",
        (account_email, mode, reply_to_id, to, cc, bcc, subject, body, int(bool(include_quote)),
         full_text, in_reply_to, references, _iso(now + timedelta(seconds=delay)), _iso(now)))
    return cur.lastrowid


def get(conn, outbox_id: int):
    return conn.execute("SELECT * FROM outbox WHERE id = ?", (outbox_id,)).fetchone()


def cancel(conn, outbox_id: int) -> bool:
    """Undo: True if it was still waiting (and now never goes out)."""
    cur = conn.execute("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'queued'",
                       (outbox_id,))
    return cur.rowcount == 1


def discard(conn, outbox_id: int) -> bool:
    """Forget a cancelled or failed email (sent and waiting ones can't be discarded)."""
    cur = conn.execute("DELETE FROM outbox WHERE id = ? AND status IN ('cancelled', 'failed')",
                       (outbox_id,))
    return cur.rowcount == 1


def failed(conn, limit: int = 5):
    return conn.execute("SELECT * FROM outbox WHERE status = 'failed' ORDER BY id DESC LIMIT ?",
                        (limit,)).fetchall()


def history(conn, limit: int = 200):
    """Mail written here, newest first (the Sent page), undone ones included so they can be
    edited or discarded."""
    return conn.execute(
        "SELECT * FROM outbox ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT ?",
        (limit,)).fetchall()


def _fail(conn, outbox_id: int, error: str) -> None:
    conn.execute("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", (error[:500], outbox_id))
    conn.commit()


def recover_stuck(conn, now: datetime | None = None) -> int:
    """The app stopped while sending: we can't know if it went out, so say so instead of
    sending it twice."""
    cutoff = _iso((now or _now()) - timedelta(minutes=STUCK_MINUTES))
    cur = conn.execute(
        """UPDATE outbox SET status = 'failed', error = 'The app stopped while sending this. Check '
           || 'your Sent folder before sending it again.' WHERE status = 'sending' AND send_after < ?""",
        (cutoff,))
    conn.commit()
    return cur.rowcount


def cleanup(conn, now: datetime | None = None) -> None:
    now = now or _now()
    conn.execute("DELETE FROM outbox WHERE status = 'cancelled' AND created_at < ?",
                 (_iso(now - timedelta(days=KEEP_UNDONE_DAYS)),))
    conn.execute("DELETE FROM outbox WHERE status = 'sent' AND sent_at < ?",
                 (_iso(now - timedelta(days=KEEP_SENT_DAYS)),))
    conn.commit()


def claim_due(conn, now: datetime | None = None) -> list[int]:
    due = [r["id"] for r in conn.execute(
        "SELECT id FROM outbox WHERE status = 'queued' AND send_after <= ? ORDER BY id",
        (_iso(now or _now()),))]
    claimed = []
    for outbox_id in due:
        cur = conn.execute("""UPDATE outbox SET status = 'sending', attempts = attempts + 1
                              WHERE id = ? AND status = 'queued'""", (outbox_id,))
        if cur.rowcount == 1:
            claimed.append(outbox_id)
    conn.commit()
    return claimed


def account_for(email: str, accounts) -> config.Account | None:
    email = (email or "").lower()
    return next((a for a in accounts if a.email.lower() == email), None)


def _load_accounts() -> list[config.Account]:
    """accounts.yaml; raises (any error) when it can't be read, so nothing gets claimed."""
    try:
        return config.load_accounts(config.ACCOUNTS_FILE)
    except SystemExit:
        return []


def send_one(conn, outbox_id: int, *, accounts=None, smtp=transport.smtp_send,
             after=transport.file_and_flag, get_password=config.get_password,
             now: datetime | None = None) -> str:
    """Send one claimed row. Returns its new status ('sent' or 'failed')."""
    row = get(conn, outbox_id)
    if row is None or row["status"] != "sending":
        return row["status"] if row else "missing"
    account = account_for(row["account_email"], accounts if accounts is not None else _load_accounts())
    if account is None:
        _fail(conn, outbox_id, f"{row['account_email']} is no longer in accounts.yaml.")
        return "failed"
    password = get_password(account.email)
    if not password:
        _fail(conn, outbox_id, f"No password saved for {account.email}.")
        return "failed"
    try:
        to, cc, bcc = (build.parse_addresses(row[k]) for k in ("to_addrs", "cc_addrs", "bcc_addrs"))
        msg = build.build(account, to, cc, bcc, row["subject"], row["full_text"],
                          row["in_reply_to"], row["references_hdr"], now=now)
    except (build.AddressError, ValueError) as exc:
        _fail(conn, outbox_id, f"Couldn't build the email: {exc}")
        return "failed"
    try:
        refused = smtp(account, password, msg, build.recipients(to, cc, bcc))
    except Exception as exc:  # noqa: BLE001 - every failure becomes a readable message
        log.warning("outbox %s: %s", outbox_id, exc)
        _fail(conn, outbox_id, transport.friendly_error(exc, account))
        return "failed"

    note = ("Not delivered to: " + ", ".join(refused)) if refused else None
    sent_at = _iso(now or _now())
    conn.execute("UPDATE outbox SET status = 'sent', sent_at = ?, message_id = ?, note = ?, error = NULL "
                 "WHERE id = ?", (sent_at, msg["Message-ID"], note, outbox_id))
    original = db.get_message(conn, row["reply_to_id"]) if row["reply_to_id"] else None
    answered = original is not None and row["mode"] in ("reply", "all")
    if answered:
        conn.execute("UPDATE messages SET answered_at = ? WHERE id = ?", (sent_at, original["id"]))
        if not original["is_read"]:
            db.set_read(conn, original["id"], True)
    conn.commit()  # recorded as sent before the IMAP bookkeeping: a crash there never resends

    uidvalidity, folder = None, None
    if answered:
        acc = conn.execute("SELECT uidvalidity, email, folder FROM accounts WHERE id = ?",
                           (original["account_id"],)).fetchone()
        uidvalidity, folder = (acc["uidvalidity"], acc["folder"]) if acc else (None, None)
        if acc is None or acc["email"].lower() != account.email.lower():
            answered = False  # sent from another address: leave that mailbox alone
    notes = after(account, password, msg, original["uid"] if answered else None, uidvalidity,
                  bcc=row["bcc_addrs"], answered_folder=folder)
    if notes:
        conn.execute("UPDATE outbox SET note = ? WHERE id = ?",
                     ("; ".join(filter(None, [note, *notes]))[:500], outbox_id))
        conn.commit()
    log.info("outbox %s: sent from %s", outbox_id, account.email)
    return "sent"


def process_due(conn_factory=db.connect, now: datetime | None = None, **kw) -> dict[int, str]:
    """One worker pass: give up on stuck sends, then send everything whose Undo time is over.
    If accounts.yaml can't be read, nothing is claimed: the mail waits until it's fixed."""
    with closing(conn_factory()) as conn:
        recover_stuck(conn, now)
        if not conn.execute("SELECT 1 FROM outbox WHERE status = 'queued' AND send_after <= ? LIMIT 1",
                            (_iso(now or _now()),)).fetchone():
            return {}
        if "accounts" not in kw:
            try:
                kw["accounts"] = _load_accounts()
            except Exception as exc:  # noqa: BLE001 - e.g. a typo in accounts.yaml
                log.error("outbox: can't read accounts.yaml, mail waits: %s", exc)
                return {}
        results = {}
        for i in claim_due(conn, now):
            try:
                results[i] = send_one(conn, i, now=now, **kw)
            except Exception as exc:  # noqa: BLE001 - one bad row never strands the others
                log.exception("outbox %s", i)
                conn.rollback()
                row = get(conn, i)
                if row is not None and row["status"] == "sending":
                    _fail(conn, i, f"Something went wrong while sending: {exc}"[:300])
                results[i] = "sent" if row is not None and row["status"] == "sent" else "failed"
        return results


def start_worker(conn_factory=db.connect, interval: float = WORKER_INTERVAL) -> threading.Event:
    """Run process_due every `interval` seconds in a daemon thread; set the returned event to stop."""
    stop = threading.Event()

    def loop():
        passes = 0
        while not stop.is_set():
            try:
                process_due(conn_factory)
                if passes % 1800 == 0:  # about once an hour
                    with closing(conn_factory()) as conn:
                        cleanup(conn)
            except Exception:  # noqa: BLE001 - keep the worker alive; the next pass retries
                log.exception("outbox worker")
            passes += 1
            stop.wait(interval)

    threading.Thread(target=loop, name="outbox", daemon=True).start()
    return stop
