from email.message import EmailMessage

import pytest
from imap_tools import MailMessage

from app import config, db
from app.sync import imap_sync


class FakeMessage(MailMessage):
    def __init__(self, uid, raw, seen=False):
        super().__init__([(b"", raw)])
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

    def fetch(self, uid_list, mark_seen, bulk):
        assert mark_seen is False
        self.server.fetched.extend(uid_list)
        return [self.server.messages[int(u)] for u in uid_list]


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
