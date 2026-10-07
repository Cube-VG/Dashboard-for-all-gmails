"""Fetch new mail from every account over IMAP and save it into SQLite.

Works the same for Gmail (imap.gmail.com + App Password) and hosting mailboxes.
Mail is never marked as read and nothing is changed on the server.
"""

import logging
import re
from datetime import date, datetime, timedelta, timezone

from bs4 import BeautifulSoup
from imap_tools import AND, U, MailBox, MailMessage

from app import config, db

log = logging.getLogger(__name__)

SNIPPET_CHARS = 300
BODY_CHARS = 20_000
FETCH_BULK = 50
IMAP_TIMEOUT = 60  # seconds; a stalled connection must not block every later sync


def connect_mailbox(host: str, port: int) -> MailBox:
    return MailBox(host, port, timeout=IMAP_TIMEOUT)


BLOCK_TAGS = ["p", "div", "tr", "li", "ul", "ol", "table", "section", "article", "header",
              "footer", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]


def html_to_text(html: str) -> str:
    """Readable plain text from HTML: inline tags join up, blocks and <br> become line breaks."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "head", "title"]):
        tag.decompose()
    for node in soup.find_all(string=True):  # whitespace inside HTML source is not a line break
        node.replace_with(re.sub(r"\s+", " ", node))
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for tag in soup.find_all(BLOCK_TAGS):
        tag.insert_before("\n")
        tag.insert_after("\n")
    return soup.get_text()


def clean_text(text: str) -> str:
    """Tidy spacing but keep the line breaks and paragraphs people need to read an email."""
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.replace("\r\n", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


HTML_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")


def parse_message(msg: MailMessage) -> dict:
    body = msg.text or (html_to_text(msg.html) if msg.html else "")
    if HTML_TAG_RE.search(body):  # some senders put HTML in the plain-text part
        body = html_to_text(body)
    body = clean_text(body)
    received = msg.date
    if received.tzinfo is None:
        received = received.replace(tzinfo=timezone.utc)
    headers = msg.headers
    return {
        "uid": int(msg.uid),
        "message_id": (headers.get("message-id") or ("",))[0].strip() or None,
        "from_name": msg.from_values.name if msg.from_values else "",
        "from_email": (msg.from_values.email if msg.from_values else msg.from_).lower(),
        "to_email": ", ".join(msg.to),
        "subject": msg.subject or "(no subject)",
        "snippet": one_line(body)[:SNIPPET_CHARS],
        "body_text": body[:BODY_CHARS],
        "received_at": received.astimezone(timezone.utc).isoformat(),
        "is_read": int("\\Seen" in msg.flags),
        "has_attachments": int(bool(msg.attachments)),
        "list_unsubscribe": (headers.get("list-unsubscribe") or ("",))[0] or None,
    }


def _new_uids(mailbox: MailBox, last_uid: int) -> list[str]:
    if last_uid:
        # "N:*" always returns at least the newest message, even if it is older than N.
        uids = mailbox.uids(AND(uid=U(last_uid + 1, "*")))
        return [u for u in uids if int(u) > last_uid]
    since = date.today() - timedelta(days=config.SYNC_DAYS_BACK)
    uids = mailbox.uids(AND(date_gte=since))
    return sorted(uids, key=int)[-config.MAX_INITIAL_MESSAGES:]


def sync_account(conn, account: config.Account, mailbox_factory=connect_mailbox) -> int:
    """Fetch mail newer than what we already have. Returns the number of new messages."""
    row = db.upsert_account(conn, account.email, account.folder, account.label, account.color)
    password = config.get_password(account.email)
    if not password:
        raise RuntimeError(
            f"No password saved for {account.email}. Run: python -m app.cli set-password {account.email}"
        )

    with mailbox_factory(account.imap_host, account.imap_port).login(
        account.username, password, initial_folder=account.folder
    ) as mailbox:
        status = mailbox.folder.status(account.folder, ["UIDVALIDITY"])
        uidvalidity = int(status["UIDVALIDITY"])
        last_uid = row["last_uid"]
        if row["uidvalidity"] != uidvalidity:
            if row["uidvalidity"] is not None:
                log.warning("%s: UIDVALIDITY changed, re-fetching mailbox", account.email)
            db.reset_account_mailbox(conn, row["id"], uidvalidity)
            last_uid = 0

        uids = _new_uids(mailbox, last_uid)
        if not uids:
            # imap-tools treats an empty uid_list as "no filter" and would fetch the whole mailbox
            db.mark_synced(conn, row["id"], last_uid)
            conn.commit()
            return 0
        added = 0
        batch: list[dict] = []
        for msg in mailbox.fetch(uid_list=uids, mark_seen=False, bulk=FETCH_BULK):
            batch.append(parse_message(msg))
            if len(batch) >= FETCH_BULK:
                added += db.insert_messages(conn, row["id"], batch)
                db.mark_synced(conn, row["id"], max(m["uid"] for m in batch))
                conn.commit()
                batch.clear()
        if batch:
            added += db.insert_messages(conn, row["id"], batch)
            last_uid = max(m["uid"] for m in batch)
        db.mark_synced(conn, row["id"], last_uid)
        conn.commit()
        return added


def refresh_bodies(conn, account: config.Account, since_iso: str,
                   mailbox_factory=connect_mailbox) -> int:
    """Re-download the text of mail already saved since `since_iso` (after a parsing fix).
    Only body_text and snippet change; scores, read state and corrections are kept."""
    row = db.upsert_account(conn, account.email, account.folder, account.label, account.color)
    uids = [str(r["uid"]) for r in conn.execute(
        "SELECT uid FROM messages WHERE account_id = ? AND received_at >= ? ORDER BY uid",
        (row["id"], since_iso))]
    if not uids:
        return 0
    password = config.get_password(account.email)
    if not password:
        raise RuntimeError(f"No password saved for {account.email}")
    updated = 0
    with mailbox_factory(account.imap_host, account.imap_port).login(
        account.username, password, initial_folder=account.folder
    ) as mailbox:
        status = mailbox.folder.status(account.folder, ["UIDVALIDITY"])
        if int(status["UIDVALIDITY"]) != row["uidvalidity"]:
            return 0  # the server renumbered its mail; the next sync re-fetches it anyway
        for start in range(0, len(uids), FETCH_BULK):
            for msg in mailbox.fetch(uid_list=uids[start:start + FETCH_BULK], mark_seen=False,
                                     bulk=FETCH_BULK):
                m = parse_message(msg)
                conn.execute("UPDATE messages SET body_text = ?, snippet = ? WHERE account_id = ? AND uid = ?",
                             (m["body_text"], m["snippet"], row["id"], m["uid"]))
                updated += 1
            conn.commit()
    return updated


def sync_all(conn, accounts: list[config.Account], mailbox_factory=connect_mailbox) -> dict[str, int | str]:
    """Sync every account; one failing account never stops the others."""
    results: dict[str, int | str] = {}
    for account in accounts:
        try:
            results[account.email] = sync_account(conn, account, mailbox_factory)
        except Exception as exc:  # noqa: BLE001 - report and keep going
            conn.rollback()
            log.error("%s: %s", account.email, exc)
            row = db.upsert_account(conn, account.email, account.folder, account.label, account.color)
            db.mark_synced(conn, row["id"], 0, error=str(exc))
            conn.commit()
            results[account.email] = f"error: {exc}"
    return results
