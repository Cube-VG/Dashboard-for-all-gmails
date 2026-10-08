"""Build the emails you send: addresses, reply/forward text and the headers that keep a reply in
the same conversation (In-Reply-To, References)."""

import re
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, getaddresses, make_msgid

MAX_RECIPIENTS = 50
MAX_BODY_CHARS = 100_000
MAX_SUBJECT_CHARS = 400
QUOTE_CHARS = 20_000  # of the original email, below a reply
REFERENCES_KEEP = 20  # message ids in References: the first one plus the newest
MODES = ("new", "reply", "all", "forward")

ADDR_RE = re.compile(r"[^@\s<>()\[\],;:\"\\]+@(?:[\w-]+\.)+[\w-]{2,}")
MSGID_RE = re.compile(r"<[^<>\s]+>")
NO_SUBJECT = "(no subject)"  # what sync stores for mail without one


class AddressError(ValueError):
    """Shown to the user as is."""


def parse_addresses(text: str | None) -> list[tuple[str, str]]:
    """'Ann <a@x.com>, b@y.com; c@z.com' -> [("Ann", "a@x.com"), ("", "b@y.com"), ...].
    Duplicates are dropped; anything that isn't an address raises AddressError."""
    text = re.sub(r"[;\r\n\t]+", ",", text or "")
    text = re.sub(r"\s*,[\s,]*", ", ", text).strip(" ,")  # "a@x.com;" and "a, , b," are fine
    out, seen = [], set()
    for name, addr in getaddresses([text]):
        name, addr = name.strip(), addr.strip()
        if not name and not addr:
            continue
        if not ADDR_RE.fullmatch(addr):
            shown = (addr or name)[:80]
            raise AddressError(f"“{shown}” isn't an email address" if shown else
                               "Some of the addresses couldn't be read")
        if addr.lower() not in seen:
            seen.add(addr.lower())
            out.append((name, addr))
    if not out and text.strip(" ,"):
        raise AddressError("Those addresses couldn't be read")
    return out


def _one_line(text: str | None) -> str:
    """Every kind of line break (incl. \x0b, \x1c, \x85, U+2028) becomes a space: mail headers
    can't contain any of them, and one hidden in an incoming subject would block every reply."""
    return " ".join((text or "").splitlines()).replace("\t", " ")


def display(name: str, addr: str) -> str:
    """'Ann Lee <ann@x.com>', quoting a name with commas or brackets."""
    name = _one_line(name).replace('"', "").strip()
    if not name:
        return addr
    if re.search(r"[,;<>@()\[\]:\\.]", name):
        name = f'"{name}"'
    return f"{name} <{addr}>"


def format_addresses(pairs) -> str:
    return ", ".join(display(n, a) for n, a in pairs)


def _subject(original) -> str:
    s = (original["subject"] or "").strip()
    return "" if s == NO_SUBJECT else s


def reply_subject(subject: str) -> str:
    subject = (subject or "").strip()
    if subject == NO_SUBJECT:
        subject = ""
    return subject if re.match(r"re\s*:", subject, re.I) else f"Re: {subject}".rstrip()


def forward_subject(subject: str) -> str:
    subject = (subject or "").strip()
    if subject == NO_SUBJECT:
        subject = ""
    return subject if re.match(r"(fwd?|fw)\s*:", subject, re.I) else f"Fwd: {subject}".rstrip()


def thread_headers(original) -> tuple[str | None, str | None]:
    """(In-Reply-To, References) for a reply to `original` (a messages row)."""
    mid = MSGID_RE.findall(original["message_id"] or "")
    ids = MSGID_RE.findall(_get(original, "references_hdr") or "")
    if mid and mid[0] not in ids:
        ids.append(mid[0])
    if len(ids) > REFERENCES_KEEP:
        ids = ids[:1] + ids[-(REFERENCES_KEEP - 1):]
    return (mid[0] if mid else None), (" ".join(ids) or None)


def _get(row, key):
    try:
        return row[key]
    except (KeyError, IndexError):
        return None


def _safe_parse(text) -> list[tuple[str, str]]:
    try:
        return parse_addresses(text)
    except AddressError:
        return []


def canonical(addr: str) -> str:
    """The mailbox an address delivers to: me+shop@x.com is me@x.com, and for Gmail dots and
    googlemail.com don't count either (v.p.2722@googlemail.com is vp2722@gmail.com)."""
    local, _, domain = (addr or "").strip().lower().rpartition("@")
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local, domain = local.replace(".", ""), "gmail.com"
    return f"{local}@{domain}"


def reply_recipients(original, mode: str, own: set[str]) -> tuple[list, list]:
    """(to, cc) for Reply or Reply all. `own` holds your addresses, which never get a copy of
    their own reply (aliases with +tags or Gmail dots included)."""
    own = {canonical(a) for a in own}
    sender = _safe_parse(_get(original, "reply_to")) or \
        [(original["from_name"] or "", original["from_email"] or "")]
    sender = [p for p in sender if ADDR_RE.fullmatch(p[1])]
    others = _safe_parse(original["to_email"]) + _safe_parse(_get(original, "cc_email"))
    if sender and all(canonical(a) in own for _, a in sender):
        # replying to mail you sent yourself: it goes back to the people you wrote to
        sender = [p for p in others if canonical(p[1]) not in own][:1]
    to = sender
    if mode != "all":
        return to, []
    taken = {canonical(a) for _, a in to} | own
    cc = []
    for name, addr in others:
        if canonical(addr) not in taken:
            taken.add(canonical(addr))
            cc.append((name, addr))
    return to, cc


def _when(original) -> str:
    try:
        d = datetime.fromisoformat(original["received_at"])
    except (TypeError, ValueError):
        return original["received_at"] or ""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    d = d.astimezone()
    return f"{d:%a}, {d.day} {d:%b} {d.year} at {d:%H:%M}"


def _sender(original) -> str:
    return display(original["from_name"] or "", original["from_email"] or "") or "someone"


def quote_reply(original) -> str:
    """'On Thu, 8 Oct 2026 at 16:40, Ann <ann@x.com> wrote:' and the original, each line '> '."""
    body = (original["body_text"] or original["snippet"] or "")[:QUOTE_CHARS]
    quoted = "\n".join(f"> {line}" if line else ">" for line in body.splitlines())
    return f"On {_when(original)}, {_sender(original)} wrote:\n{quoted}"


def forward_block(original) -> str:
    lines = ["---------- Forwarded message ---------", f"From: {_sender(original)}",
             f"Date: {_when(original)}", f"Subject: {_subject(original)}"]
    if original["to_email"]:
        lines.append(f"To: {original['to_email']}")
    if _get(original, "cc_email"):
        lines.append(f"Cc: {original['cc_email']}")
    body = (original["body_text"] or original["snippet"] or "")[:QUOTE_CHARS]
    return "\n".join(lines) + "\n\n" + body


def full_text(body: str, mode: str, original, include_quote: bool) -> str:
    """What actually goes out: your text, plus the quoted original (reply) or the forwarded
    email (forward)."""
    body = (body or "").rstrip()
    if original is not None and mode == "forward":
        return (body + "\n\n" if body else "") + forward_block(original)
    if original is not None and mode in ("reply", "all") and include_quote:
        return (body + "\n\n" if body else "") + quote_reply(original)
    return body


def clean_subject(subject: str | None) -> str:
    return re.sub(r" {2,}", " ", _one_line(subject)).strip()[:MAX_SUBJECT_CHARS]


def build(account, to, cc, bcc, subject: str, text: str, in_reply_to: str | None = None,
          references: str | None = None, now: datetime | None = None) -> EmailMessage:
    """A ready-to-send plain-text email from `account` (config.Account). Bcc is not a header."""
    msg = EmailMessage()
    msg["From"] = display(account.from_name, account.email)
    if to:
        msg["To"] = format_addresses(to)
    elif not cc:
        msg["To"] = "undisclosed-recipients:;"
    if cc:
        msg["Cc"] = format_addresses(cc)
    msg["Subject"] = clean_subject(subject)
    msg["Date"] = format_datetime((now or datetime.now(timezone.utc)).astimezone())
    msg["Message-ID"] = make_msgid(domain=account.email.rsplit("@", 1)[-1])
    if in_reply_to and MSGID_RE.fullmatch(in_reply_to):
        msg["In-Reply-To"] = in_reply_to
    refs = " ".join(MSGID_RE.findall(references or ""))
    if refs:
        msg["References"] = refs
    msg.set_content(text or "")  # UTF-8; long lines are wrapped safely (quoted-printable)
    return msg


def recipients(*groups) -> list[str]:
    seen, out = set(), []
    for group in groups:
        for _, addr in group:
            if addr.lower() not in seen:
                seen.add(addr.lower())
                out.append(addr)
    return out
