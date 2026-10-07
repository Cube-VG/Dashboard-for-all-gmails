"""SQLite storage. The whole database is one file (DB_PATH)."""

import sqlite3
from pathlib import Path

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

CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unscored ON messages(scored_by) WHERE scored_by IS NULL;
"""

MESSAGE_FIELDS = (
    "uid", "message_id", "from_name", "from_email", "to_email", "subject", "snippet",
    "body_text", "received_at", "is_read", "has_attachments", "list_unsubscribe",
)


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


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
        [(account_id, *(m[f] for f in MESSAGE_FIELDS)) for m in messages],
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
