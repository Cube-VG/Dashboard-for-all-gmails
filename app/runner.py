"""One background cycle: fetch new mail, score it, pop up the important ones.

Run every few minutes by app.scheduler and by the dashboard's "Sync now" button.
"""

import contextlib
import logging
import os
import threading
from datetime import datetime, timezone

from app import config, db
from app import notify as notifier

log = logging.getLogger(__name__)

NOTIFY_THRESHOLD = float(os.getenv("NOTIFY_THRESHOLD", "4.5"))
MAX_NOTIFICATIONS = int(os.getenv("MAX_NOTIFICATIONS_PER_CYCLE", "3"))

# Every message the notifier has already looked at (popped up or not), so nothing
# pops up twice and old mail that gets scored late stays quiet.
NOTIFIED_SCHEMA = """CREATE TABLE IF NOT EXISTS notified (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
)"""

_lock = threading.Lock()


def is_running() -> bool:
    return _lock.locked()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default_sync(conn, accounts):
    from app.sync.imap_sync import sync_all

    return sync_all(conn, accounts)


def _default_classify(conn):
    from app.ai.classifier import classify_pending

    return classify_pending(conn)


def _stage(name: str, fn, errors: list[str], conn=None):
    """Run one step; on failure log it, note it in errors and return None."""
    try:
        result = fn()
        if conn is not None:
            conn.commit()
        return result
    except (Exception, SystemExit) as exc:  # SystemExit: config.load_accounts' "file missing"
        if isinstance(exc, SystemExit):  # a setup problem, not a bug: no traceback
            log.warning("%s: %s", name, exc)
        else:
            log.exception("%s failed", name)
        errors.append(f"{name}: {exc}")
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.rollback()
        return None


def _describe(row) -> tuple[str, str]:
    sender = row["from_name"] or row["from_email"] or "Unknown sender"
    text = row["subject"] or "(no subject)"
    if row["summary"]:
        text += "\n" + row["summary"]
    return f"{sender} ({row['account_label']})", text


def notify_new(conn, notify=None) -> int:
    """Pop up newly scored mail with priority >= NOTIFY_THRESHOLD. Returns how many.

    The first time (nothing recorded yet) all existing mail is marked as seen without
    popping up, so the first sync of a full inbox doesn't flood the desktop.
    """
    notify = notify or notifier.notify
    conn.execute(NOTIFIED_SCHEMA)
    if conn.execute("SELECT 1 FROM notified LIMIT 1").fetchone() is None:
        cur = conn.execute("INSERT OR IGNORE INTO notified (message_id) SELECT id FROM messages")
        conn.commit()
        if cur.rowcount:
            log.info("First run: %d existing messages marked as already notified", cur.rowcount)
        return 0

    fresh = conn.execute(
        """SELECT m.id, m.from_name, m.from_email, m.subject, m.summary, m.is_read,
                  m.priority_score, m.scored_by, a.label AS account_label
           FROM messages m JOIN accounts a ON a.id = m.account_id
           WHERE m.priority_score IS NOT NULL
             AND m.id NOT IN (SELECT message_id FROM notified)
           ORDER BY m.priority_score DESC, m.received_at DESC"""
    ).fetchall()
    conn.executemany("INSERT OR IGNORE INTO notified (message_id) VALUES (?)",
                     [(r["id"],) for r in fresh])
    conn.commit()  # before popping up, so a crash can't cause repeats

    important = [r for r in fresh if r["priority_score"] >= NOTIFY_THRESHOLD
                 and not r["is_read"] and r["scored_by"] != "user"]
    for row in important[:MAX_NOTIFICATIONS]:
        notify(*_describe(row))
    extra = len(important) - MAX_NOTIFICATIONS
    if extra > 0:
        notify("Unified inbox", f"...and {extra} more important email{'s' if extra > 1 else ''}")
    return len(important)


def run_cycle(conn_factory=db.connect, accounts=None, *, sync=None, classify=None,
              notify=None) -> dict:
    """Sync every account, score new mail, notify about important mail. Never raises.

    Only one cycle runs at a time: returns {"status": "already running"} if one is busy.
    """
    if not _lock.acquire(blocking=False):
        return {"status": "already running"}
    try:
        return _cycle(conn_factory, accounts, sync or _default_sync,
                      classify or _default_classify, notify)
    finally:
        _lock.release()


def _cycle(conn_factory, accounts, sync, classify, notify) -> dict:
    result = {"sync": None, "classify": None, "notified": 0, "started_at": _now()}
    errors: list[str] = []
    conn = _stage("database", conn_factory, errors)
    if conn is not None:
        try:
            if accounts is None:
                accounts = _stage("accounts", config.load_accounts, errors)
            if accounts is not None:
                result["sync"] = _stage("sync", lambda: sync(conn, accounts), errors, conn)
            result["classify"] = _stage("classify", lambda: classify(conn), errors, conn)
            result["notified"] = _stage("notify", lambda: notify_new(conn, notify), errors, conn) or 0
        finally:
            conn.close()
    result["finished_at"] = _now()
    if errors:
        result["error"] = "; ".join(errors)
    log.info("Cycle done: sync=%s classify=%s notified=%s%s", result["sync"], result["classify"],
             result["notified"], f" errors={result['error']}" if errors else "")
    return result
