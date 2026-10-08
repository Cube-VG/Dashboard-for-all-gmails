"""SQLite storage. The whole database is one file (DB_PATH)."""

import sqlite3
from pathlib import Path

from app.ai.scoring import priority_score
from app.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL,
    folder        TEXT NOT NULL DEFAULT 'INBOX',
    label         TEXT NOT NULL,
    color         TEXT,
    uidvalidity   INTEGER,
    last_uid      INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    last_error    TEXT,
    UNIQUE(email, folder)
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    uid             INTEGER NOT NULL,
    message_id      TEXT,
    from_name       TEXT,
    from_email      TEXT,
    to_email        TEXT,
    subject         TEXT,
    snippet         TEXT,
    body_text       TEXT,
    received_at     TEXT,
    is_read         INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    list_unsubscribe TEXT,
    -- for replies: who to answer, who else was on it, and the thread it belongs to
    reply_to        TEXT,
    cc_email        TEXT,
    references_hdr  TEXT,
    answered_at     TEXT,
    -- filled in by the AI step (step 3)
    importance      INTEGER,
    urgency         INTEGER,
    category        TEXT,
    action_needed   INTEGER,
    deadline        TEXT,
    summary         TEXT,
    reason          TEXT,
    priority_score  REAL,
    scored_by       TEXT,
    UNIQUE(account_id, uid)
);

-- your corrections (step 5): fed back to Gemma as examples
CREATE TABLE IF NOT EXISTS feedback (
    id             INTEGER PRIMARY KEY,
    message_id     INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    old_importance INTEGER,
    old_urgency    INTEGER,
    new_importance INTEGER NOT NULL,
    new_urgency    INTEGER NOT NULL,
    new_category   TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- sender rules: kind = 'vip' (always important), 'low' (always unimportant),
-- 'private' (never sent to the AI). pattern = full address or '@domain.com'.
CREATE TABLE IF NOT EXISTS rules (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('vip', 'low', 'private')),
    pattern    TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(kind, pattern)
);

-- AI requests per day, so MAX_AI_CALLS_PER_DAY can be enforced
CREATE TABLE IF NOT EXISTS ai_usage (
    day   TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0
);

-- optional login (app/web/auth.py): sessions, failed attempts, last authenticator step used
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
);
CREATE TABLE IF NOT EXISTS login_failures (
    client TEXT NOT NULL,
    at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(client, at);
CREATE INDEX IF NOT EXISTS idx_login_failures_at ON login_failures(at);
CREATE TABLE IF NOT EXISTS auth_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- mail you write: waits a few seconds (Undo), then goes out over the account's SMTP server.
-- status: queued -> sending -> sent | failed; queued -> cancelled (Undo)
CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY,
    account_email   TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'new',
    reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    to_addrs        TEXT NOT NULL DEFAULT '',
    cc_addrs        TEXT NOT NULL DEFAULT '',
    bcc_addrs       TEXT NOT NULL DEFAULT '',
    subject         TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    include_quote   INTEGER NOT NULL DEFAULT 1,
    full_text       TEXT NOT NULL DEFAULT '',
    in_reply_to     TEXT,
    references_hdr  TEXT,
    status          TEXT NOT NULL DEFAULT 'queued',
    send_after      TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    note            TEXT,
    message_id      TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, send_after);

CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unscored ON messages(scored_by) WHERE scored_by IS NULL;
"""

MESSAGE_FIELDS = (
    "uid", "message_id", "from_name", "from_email", "to_email", "subject", "snippet",
    "body_text", "received_at", "is_read", "has_attachments", "list_unsubscribe",
    "reply_to", "cc_email", "references_hdr",
)
NEW_MESSAGE_COLUMNS = ("reply_to", "cc_email", "references_hdr", "answered_at")


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)  # wait for the app's own writes instead of failing
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")  # web page can read while a sync writes
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def _migrate(conn) -> None:
    """One-time fixes for databases made by older versions (tracked in PRAGMA user_version)."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:  # read mail used to lose 0.5 priority, which made opened emails jump down
        conn.execute("UPDATE messages SET priority_score = priority_score + 0.5 "
                     "WHERE is_read = 1 AND priority_score IS NOT NULL")
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
    if version < 2:  # sending: reply headers (Reply-To, Cc, References) on saved mail
        have = {r["name"] for r in conn.execute("PRAGMA table_info(messages)")}
        for col in NEW_MESSAGE_COLUMNS:
            if col not in have:
                conn.execute(f"ALTER TABLE messages ADD COLUMN {col} TEXT")
        if conn.execute("SELECT 1 FROM messages LIMIT 1").fetchone():
            # mail synced before this has none: the next sync re-reads its headers once
            conn.execute("INSERT OR REPLACE INTO auth_state (key, value) VALUES (?, 'pending')",
                         (HEADERS_BACKFILL,))
        conn.execute("PRAGMA user_version = 2")
        conn.commit()


HEADERS_BACKFILL = "headers_backfill"


def backfill_pending(conn) -> bool:
    return conn.execute("SELECT 1 FROM auth_state WHERE key = ?", (HEADERS_BACKFILL,)).fetchone() is not None


def backfill_done(conn) -> None:
    conn.execute("DELETE FROM auth_state WHERE key = ?", (HEADERS_BACKFILL,))


def upsert_account(conn, email: str, folder: str, label: str, color: str) -> sqlite3.Row:
    conn.execute(
        """INSERT INTO accounts (email, folder, label, color) VALUES (?, ?, ?, ?)
           ON CONFLICT(email, folder) DO UPDATE SET label = excluded.label, color = excluded.color""",
        (email, folder, label, color),
    )
    return conn.execute(
        "SELECT * FROM accounts WHERE email = ? AND folder = ?", (email, folder)
    ).fetchone()


def reset_account_mailbox(conn, account_id: int, uidvalidity: int) -> None:
    """The server renumbered its UIDs, so the old ones mean nothing: start over."""
    conn.execute("DELETE FROM messages WHERE account_id = ?", (account_id,))
    conn.execute(
        "UPDATE accounts SET uidvalidity = ?, last_uid = 0 WHERE id = ?", (uidvalidity, account_id)
    )


def insert_messages(conn, account_id: int, messages: list[dict]) -> int:
    cols = ", ".join(("account_id",) + MESSAGE_FIELDS)
    marks = ", ".join("?" * (len(MESSAGE_FIELDS) + 1))
    cur = conn.executemany(
        f"INSERT OR IGNORE INTO messages ({cols}) VALUES ({marks})",
        [(account_id, *(m.get(f) for f in MESSAGE_FIELDS)) for m in messages],
    )
    return cur.rowcount


def mark_synced(conn, account_id: int, last_uid: int, error: str | None = None) -> None:
    conn.execute(
        """UPDATE accounts SET last_uid = MAX(last_uid, ?), last_error = ?,
           last_synced_at = datetime('now') WHERE id = ?""",
        (last_uid, error, account_id),
    )


def recent_messages(conn, limit: int = 30, account_email: str | None = None):
    sql = """SELECT m.*, a.label AS account_label, a.email AS account_email
             FROM messages m JOIN accounts a ON a.id = m.account_id"""
    args: list = []
    if account_email:
        sql += " WHERE a.email = ?"
        args.append(account_email)
    sql += " ORDER BY m.received_at DESC LIMIT ?"
    args.append(limit)
    return conn.execute(sql, args).fetchall()


def get_message(conn, message_id: int):
    return conn.execute(
        """SELECT m.*, a.label AS account_label, a.email AS account_email, a.color AS account_color
           FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?""",
        (message_id,),
    ).fetchone()


def save_scores(conn, message_id: int, scores: dict, scored_by: str) -> None:
    """Store AI/rule results. scores keys: importance, urgency, category, action_needed,
    deadline, summary, reason (missing keys are stored as NULL)."""
    row = conn.execute("SELECT is_read FROM messages WHERE id = ?", (message_id,)).fetchone()
    prio = priority_score(scores.get("importance"), scores.get("urgency"), scores.get("deadline"),
                          scores.get("action_needed"), row["is_read"] if row else False)
    conn.execute(
        """UPDATE messages SET importance = ?, urgency = ?, category = ?, action_needed = ?,
           deadline = ?, summary = ?, reason = ?, priority_score = ?, scored_by = ? WHERE id = ?""",
        (scores.get("importance"), scores.get("urgency"), scores.get("category"),
         int(bool(scores.get("action_needed"))), scores.get("deadline"), scores.get("summary"),
         scores.get("reason"), prio, scored_by, message_id),
    )


def record_feedback(conn, message_id: int, importance: int, urgency: int,
                    category: str | None = None) -> None:
    """You corrected a score: remember it and apply it."""
    m = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if m is None:
        raise KeyError(message_id)
    conn.execute(
        """INSERT INTO feedback (message_id, old_importance, old_urgency, new_importance,
           new_urgency, new_category) VALUES (?, ?, ?, ?, ?, ?)""",
        (message_id, m["importance"], m["urgency"], importance, urgency, category or m["category"]),
    )
    prio = priority_score(importance, urgency, m["deadline"], m["action_needed"], m["is_read"])
    conn.execute(
        """UPDATE messages SET importance = ?, urgency = ?, category = COALESCE(?, category),
           priority_score = ?, scored_by = 'user' WHERE id = ?""",
        (importance, urgency, category, prio, message_id),
    )


def set_read(conn, message_id: int, is_read: bool) -> None:
    m = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if m is None:
        raise KeyError(message_id)
    prio = priority_score(m["importance"], m["urgency"], m["deadline"], m["action_needed"], is_read)
    conn.execute("UPDATE messages SET is_read = ?, priority_score = ? WHERE id = ?",
                 (int(is_read), prio, message_id))


def add_rule(conn, kind: str, pattern: str) -> None:
    conn.execute("INSERT OR IGNORE INTO rules (kind, pattern) VALUES (?, ?)",
                 (kind, pattern.strip().lower()))


def list_rules(conn):
    return conn.execute("SELECT * FROM rules ORDER BY kind, pattern").fetchall()


def delete_rule(conn, rule_id: int) -> None:
    conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))


def list_accounts(conn):
    return conn.execute("SELECT * FROM accounts ORDER BY label").fetchall()


def unscored_messages(conn, limit: int = 100):
    return conn.execute(
        "SELECT * FROM messages WHERE scored_by IS NULL ORDER BY received_at DESC LIMIT ?", (limit,)
    ).fetchall()


def recent_feedback(conn, limit: int = 5):
    """Your latest corrections joined with the email they were about (for few-shot examples)."""
    return conn.execute(
        """SELECT f.*, m.from_email, m.subject, m.snippet FROM feedback f
           JOIN messages m ON m.id = f.message_id ORDER BY f.id DESC LIMIT ?""",
        (limit,),
    ).fetchall()


def ai_calls_today(conn, day: str) -> int:
    row = conn.execute("SELECT calls FROM ai_usage WHERE day = ?", (day,)).fetchone()
    return row["calls"] if row else 0


def count_ai_call(conn, day: str) -> None:
    conn.execute(
        "INSERT INTO ai_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1",
        (day,),
    )


def prune_old_messages(conn, before_iso: str) -> int:
    """Delete mail received before `before_iso`, keeping anything you corrected yourself."""
    cur = conn.execute(
        """DELETE FROM messages WHERE received_at < ? AND COALESCE(scored_by, '') != 'user'
           AND id NOT IN (SELECT message_id FROM feedback)""",
        (before_iso,),
    )
    return cur.rowcount
