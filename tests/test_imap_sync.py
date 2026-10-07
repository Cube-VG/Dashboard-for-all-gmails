from email.message import EmailMessage

import pytest
from imap_tools import MailMessage

from app import config, db
from app.sync import imap_sync


class FakeMessage(MailMessage):
    def __init__(self, uid, raw, seen=False):
        super().__init__([(b"", raw)])
        self.raw, self.seen = raw, seen
        self._uid, self._flags = str(uid), ("\\Seen",) if seen else ()

    @property
    def uid(self):
        return self._uid

    @property
    def flags(self):
        return self._flags


def make_raw(subject, sender="Alice <alice@example.com>", html=None, text="Hello there", unsub=None):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = sender, "me@example.com", subject
    m["Date"] = "Tue, 06 Oct 2026 09:30:00 +0530"
    m["Message-ID"] = f"<{subject.replace(' ', '')}@example.com>"
    if unsub:
        m["List-Unsubscribe"] = unsub
    if html:
        m.set_content(html, subtype="html")
    else:
        m.set_content(text)
    return m.as_bytes()


class FakeServer:
    def __init__(self, uidvalidity=1):
        self.uidvalidity, self.messages, self.fetched = uidvalidity, {}, []

    def add(self, uid, seen=False, **kw):
        self.messages[uid] = FakeMessage(uid, make_raw(**kw), seen=seen)


class FakeMailBox:
    def __init__(self, server):
        self.server = server
        outer = self

        class Folder:
            def status(self, folder, items):
                return {"UIDVALIDITY": outer.server.uidvalidity}

        self.folder = Folder()

    def login(self, *a, **kw):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def uids(self, criteria):
        c = str(criteria)
        if "UID" in c:
            start = int(c.split("UID ")[1].split(":")[0])
            found = [u for u in self.server.messages if u >= start]
            # mimic real servers: "N:*" returns the newest message even if below N
            return [str(u) for u in (found or [max(self.server.messages)])]
        return [str(u) for u in self.server.messages]

    @property
    def client(self):
        return FakeIMAPClient(self.server)


class FakeIMAPClient:
    """Answers UID FETCH the way imaplib returns it: (header, literal) tuples, each followed by
    the rest of its line. Odd messages put UID/FLAGS after the literal, like Gmail sometimes does."""

    def __init__(self, server):
        self.server = server

    def uid(self, command, uid_set, parts):
        assert command == "fetch" and "BODY.PEEK[]<0." in parts  # partial, and never marks read
        cap = int(parts.split("<0.")[1].split(">")[0])
        uids = uid_set.split(",")
        assert uids and all(uids), "empty UID set would fetch nothing (or everything)"
        self.server.fetched.extend(uids)
        data = []
        for n, u in enumerate(uids, 1):
            m = self.server.messages[int(u)]
            body, flags = m.raw[:cap], "\\Seen" if m.seen else ""
            if n % 2:
                data += [(f"{n} (UID {u} RFC822.SIZE {len(m.raw)} FLAGS ({flags}) BODY[]<0> {{{len(body)}}}".encode(), body), b")"]
            else:
                data += [(f"{n} (RFC822.SIZE {len(m.raw)} BODY[]<0> {{{len(body)}}}".encode(), body), f" UID {u} FLAGS ({flags}))".encode()]
        return "OK", data


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "get_password", lambda email: "pw")
    c = db.connect(tmp_path / "t.db")
    yield c
    c.close()


ACCOUNT = config.Account(label="Test", email="me@example.com", imap_host="imap.example.com")


def run(conn, server):
    return imap_sync.sync_account(conn, ACCOUNT, mailbox_factory=lambda h, p: FakeMailBox(server))


def test_first_sync_then_only_new_mail(conn):
    server = FakeServer()
    server.add(10, subject="First")
    server.add(11, subject="Second")
    assert run(conn, server) == 2

    assert run(conn, server) == 0  # nothing new, and the "N:*" quirk is filtered out
    assert server.fetched == ["10", "11"]

    server.add(12, subject="Third")
    assert run(conn, server) == 1
    assert [m["subject"] for m in db.recent_messages(conn, 10)].count("Third") == 1


def test_no_new_mail_fetches_nothing(conn):
    server = FakeServer()
    for uid in range(1, 6):
        server.add(uid, subject=f"Mail {uid}")
    run(conn, server)
    server.fetched.clear()
    for _ in range(3):
        assert run(conn, server) == 0
    assert server.fetched == []


def test_html_in_plain_text_part_is_stripped(conn):
    server = FakeServer()
    server.add(1, subject="Bill", text='Your bill is <span style="color:#c45500;"><b>due</b></span> today')
    run(conn, server)
    assert db.recent_messages(conn, 1)[0]["snippet"] == "Your bill is due today"


def test_parses_fields(conn):
    server = FakeServer()
    server.add(5, subject="News", html="<html><style>x{}</style><p>Big <b>sale</b></p></html>",
               unsub="<mailto:u@shop.com>")
    run(conn, server)
    m = db.recent_messages(conn, 1)[0]
    assert m["from_email"] == "alice@example.com" and m["from_name"] == "Alice"
    assert m["snippet"] == "Big sale"
    assert m["received_at"] == "2026-10-06T04:00:00+00:00"
    assert m["list_unsubscribe"] == "<mailto:u@shop.com>"
    assert m["is_read"] == 0


def test_uidvalidity_change_refetches(conn):
    server = FakeServer(uidvalidity=1)
    server.add(1, subject="Old")
    run(conn, server)
    server.uidvalidity, server.messages = 2, {}
    server.add(1, subject="Renumbered")
    assert run(conn, server) == 1
    assert [m["subject"] for m in db.recent_messages(conn, 10)] == ["Renumbered"]


def test_one_bad_account_does_not_stop_others(conn, monkeypatch):
    good = FakeServer()
    good.add(1, subject="Hi")

    def factory(host, port):
        if host == "bad.example.com":
            raise ConnectionError("cannot connect")
        return FakeMailBox(good)

    bad = config.Account(label="Bad", email="bad@example.com", imap_host="bad.example.com")
    results = imap_sync.sync_all(conn, [bad, ACCOUNT], mailbox_factory=factory)
    assert results["bad@example.com"].startswith("error")
    assert results["me@example.com"] == 1


def test_prune_keeps_recent_and_corrected_mail(conn):
    row = db.upsert_account(conn, "me@example.com", "INBOX", "Test", "#000")
    base = dict(message_id=None, from_name="", from_email="a@b.c", to_email="", snippet="",
                body_text="", is_read=0, has_attachments=0, list_unsubscribe=None)
    db.insert_messages(conn, row["id"], [
        {**base, "uid": 1, "subject": "old", "received_at": "2026-01-01T00:00:00+00:00"},
        {**base, "uid": 2, "subject": "old but corrected", "received_at": "2026-01-02T00:00:00+00:00"},
        {**base, "uid": 3, "subject": "new", "received_at": "2026-10-06T00:00:00+00:00"},
    ])
    corrected = conn.execute("SELECT id FROM messages WHERE uid = 2").fetchone()["id"]
    db.record_feedback(conn, corrected, 5, 5)
    assert db.prune_old_messages(conn, "2026-09-23T00:00:00+00:00") == 1
    assert sorted(m["subject"] for m in db.recent_messages(conn, 10)) == ["new", "old but corrected"]


def test_body_keeps_paragraphs_and_snippet_is_one_line(conn):
    server = FakeServer()
    server.add(1, subject="Statement", text="Dear Customer,\r\n\r\nYour   statement is ready.\r\nPassword: PAN\r\n\r\n\r\n\r\nThanks")
    run(conn, server)
    m = db.recent_messages(conn, 1)[0]
    assert m["body_text"] == "Dear Customer,\n\nYour statement is ready.\nPassword: PAN\n\nThanks"
    assert m["snippet"] == "Dear Customer, Your statement is ready. Password: PAN Thanks"


def test_html_blocks_become_lines_but_inline_tags_do_not():
    text = imap_sync.clean_text(imap_sync.html_to_text(
        "<html><head><title>x</title></head><body><p>Hello <b>Jane</b>,\n  welcome</p>"
        "<div>Line two<br>Line three</div><table><tr><td>A</td></tr><tr><td>B</td></tr></table></body></html>"))
    assert text == "Hello Jane, welcome\n\nLine two\nLine three\n\nA\n\nB"


def test_refresh_bodies_rewrites_text_only(conn):
    server = FakeServer()
    server.add(1, subject="Hi", text="old text")
    run(conn, server)
    mid = conn.execute("SELECT id FROM messages").fetchone()["id"]
    db.record_feedback(conn, mid, 5, 5)
    db.set_read(conn, mid, True)
    server.messages = {}
    server.add(1, subject="Hi", text="Line one\n\nLine two")
    n = imap_sync.refresh_bodies(conn, ACCOUNT, "2000-01-01", mailbox_factory=lambda h, p: FakeMailBox(server))
    m = db.recent_messages(conn, 1)[0]
    assert n == 1 and m["body_text"] == "Line one\n\nLine two"
    assert (m["importance"], m["urgency"], m["scored_by"], m["is_read"]) == (5, 5, "user", 1)


def test_seen_flag_and_uid_parsed_in_both_response_layouts(conn):
    server = FakeServer()
    server.add(1, subject="One", seen=True)
    server.add(2, subject="Two", seen=True)   # flags arrive after the literal
    server.add(3, subject="Three")
    run(conn, server)
    got = {m["subject"]: (m["uid"], m["is_read"]) for m in db.recent_messages(conn, 10)}
    assert got == {"One": (1, 1), "Two": (2, 1), "Three": (3, 0)}


def test_big_attachment_is_cut_off_but_text_and_flag_survive(conn, monkeypatch):
    monkeypatch.setattr(imap_sync, "MAX_FETCH_BYTES", 4000)
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = "Bank <s@bank.com>", "me@example.com", "Statement"
    m["Date"] = "Tue, 06 Oct 2026 09:30:00 +0530"
    m.set_content("Your statement is attached.\n\nThanks")
    m.add_attachment(b"%PDF" + bytes(range(256)) * 400, maintype="application", subtype="pdf",
                     filename="statement.pdf")
    server = FakeServer()
    server.messages[7] = FakeMessage(7, m.as_bytes())
    run(conn, server)
    row = db.recent_messages(conn, 1)[0]
    assert row["body_text"] == "Your statement is attached.\n\nThanks"
    assert row["has_attachments"] == 1


def test_refresh_bodies_reports_progress(conn):
    server = FakeServer()
    for uid in range(1, 121):
        server.add(uid, subject=f"M{uid}")
    run(conn, server)
    seen = []
    imap_sync.refresh_bodies(conn, ACCOUNT, "2000-01-01", mailbox_factory=lambda h, p: FakeMailBox(server),
                             progress=lambda done, total: seen.append((done, total)))
    assert seen == [(50, 120), (100, 120), (120, 120)]
