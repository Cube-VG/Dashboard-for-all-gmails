import base64
import functools
import subprocess
import sys
import threading
import time
import types
from datetime import timedelta

import pytest

import app.__main__ as launcher
from app import config, db, runner, scheduler
from app import notify as notify_mod

ACCOUNT = "me@example.com"


@pytest.fixture
def factory(tmp_path):
    path = tmp_path / "t.db"
    return lambda: db.connect(path)


def add_mail(conn, subject, priority=None, is_read=0, scored_by="gemma"):
    acc = db.upsert_account(conn, ACCOUNT, "INBOX", "Work", "#123456")
    uid = conn.execute("SELECT COALESCE(MAX(uid), 0) + 1 FROM messages").fetchone()[0]
    db.insert_messages(conn, acc["id"], [{
        "uid": uid, "message_id": None, "from_name": "Alice", "from_email": "alice@example.com",
        "to_email": ACCOUNT, "subject": subject, "snippet": "", "body_text": "",
        "received_at": f"2026-10-06T10:{uid // 60:02d}:{uid % 60:02d}+00:00", "is_read": is_read,
        "has_attachments": 0, "list_unsubscribe": None,
    }])
    mid = conn.execute("SELECT id FROM messages WHERE uid = ?", (uid,)).fetchone()["id"]
    if priority is not None:
        conn.execute("UPDATE messages SET priority_score = ?, scored_by = ? WHERE id = ?",
                     (priority, scored_by, mid))
    conn.commit()
    return mid


class Fakes:
    """sync() adds the `incoming` mail unscored; classify() scores it from `scores`."""

    def __init__(self):
        self.calls, self.notes, self.incoming, self.scores = [], [], [], {}

    def sync(self, conn, accounts):
        self.calls.append("sync")
        for subject, prio in self.incoming:
            add_mail(conn, subject)
            self.scores[subject] = prio
        added, self.incoming = len(self.incoming), []
        return {ACCOUNT: added}

    def classify(self, conn):
        self.calls.append("classify")
        rows = conn.execute("SELECT id, subject FROM messages WHERE scored_by IS NULL").fetchall()
        for r in rows:
            conn.execute("UPDATE messages SET priority_score = ?, scored_by = 'gemma' WHERE id = ?",
                         (self.scores.get(r["subject"], 1.0), r["id"]))
        return {"rule_scored": 0, "ai_scored": len(rows), "failed": 0, "skipped_budget": 0}

    def notify(self, title, message):
        self.calls.append("notify")
        self.notes.append((title, message))
        return True

    def run(self, factory, accounts=(), **kw):
        kw = {"sync": self.sync, "classify": self.classify, "notify": self.notify, **kw}
        return runner.run_cycle(factory, list(accounts) if accounts is not None else None, **kw)


def notified_ids(factory):
    conn = factory()
    try:
        return {r[0] for r in conn.execute("SELECT message_id FROM notified")}
    finally:
        conn.close()


def baseline(factory, fakes):
    """First cycle with some mail present, so later cycles notify normally."""
    conn = factory()
    add_mail(conn, "old news", priority=5.0)
    conn.close()
    assert fakes.run(factory)["notified"] == 0
    assert fakes.notes == []


# --- runner -------------------------------------------------------------------------

def test_cycle_runs_stages_in_order(factory):
    f = Fakes()
    seen = []
    f.incoming = [("hello", 2.0)]
    result = f.run(factory, sync=lambda conn, accts: seen.append(accts) or f.sync(conn, accts),
                   accounts=["acct"])
    assert f.calls == ["sync", "classify"]
    assert seen == [["acct"]]
    assert result["sync"] == {ACCOUNT: 1}
    assert result["classify"]["ai_scored"] == 1
    assert result["notified"] == 0
    assert "error" not in result
    assert result["started_at"] <= result["finished_at"]


def test_lock_blocks_a_second_cycle(factory):
    started, release = threading.Event(), threading.Event()

    def slow_sync(conn, accounts):
        started.set()
        release.wait(5)
        return {}

    f = Fakes()
    t = threading.Thread(target=f.run, args=(factory,), kwargs={"sync": slow_sync})
    t.start()
    try:
        assert started.wait(5)
        assert runner.is_running()
        assert f.run(factory) == {"status": "already running"}
    finally:
        release.set()
        t.join(5)
    assert not runner.is_running()
    assert "sync" in f.run(factory)


def test_lock_held_manually(factory):
    f = Fakes()
    with runner._lock:
        assert f.run(factory) == {"status": "already running"}
    assert f.calls == []


def test_sync_error_does_not_stop_classify(factory):
    f = Fakes()

    def broken_sync(conn, accounts):
        raise RuntimeError("imap down")

    result = f.run(factory, sync=broken_sync)
    assert f.calls == ["classify"]
    assert result["sync"] is None
    assert result["classify"] is not None
    assert "sync: imap down" in result["error"]


def test_classify_and_notify_errors_are_reported(factory):
    f = Fakes()
    baseline(factory, f)
    f.incoming = [("urgent", 5.0)]

    def broken_classify(conn):
        conn.execute("UPDATE messages SET priority_score = 5, scored_by = 'gemma'")
        raise ValueError("bad json")

    result = f.run(factory, classify=broken_classify)
    assert "classify: bad json" in result["error"]
    assert result["notified"] == 0  # the half-done classify was rolled back

    def broken_notify(title, message):
        raise OSError("no display")

    result = f.run(factory, notify=broken_notify)
    assert "notify: no display" in result["error"]
    assert result["classify"]["ai_scored"] == 1


def test_database_error_is_reported(factory):
    def no_db():
        raise OSError("disk full")

    result = Fakes().run(no_db)
    assert result["error"] == "database: disk full"
    assert "finished_at" in result


def test_missing_accounts_file(factory, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "load_accounts",
                        functools.partial(config.load_accounts, tmp_path / "missing.yaml"))
    f = Fakes()
    result = f.run(factory, accounts=None)
    assert f.calls == ["classify"]
    assert result["sync"] is None
    assert result["error"].startswith("accounts: missing.yaml not found")


def test_notifies_above_threshold_once(factory):
    f = Fakes()
    baseline(factory, f)
    f.incoming = [("meh", 4.4), ("edge", 4.5), ("urgent", 5.2)]
    result = f.run(factory)
    assert result["notified"] == 2
    assert [n[1] for n in f.notes] == ["urgent", "edge"]  # highest first
    assert f.notes[0][0] == "Alice (Work)"

    result = f.run(factory)
    assert result["notified"] == 0
    assert len(f.notes) == 2


def test_threshold_is_configurable(factory, monkeypatch):
    monkeypatch.setattr(runner, "NOTIFY_THRESHOLD", 3.0)
    f = Fakes()
    baseline(factory, f)
    f.incoming = [("fyi", 3.5), ("spam", 1.0)]
    assert f.run(factory)["notified"] == 1
    assert f.notes[0][1] == "fyi"


def test_read_and_user_scored_mail_stays_quiet(factory):
    f = Fakes()
    baseline(factory, f)
    conn = factory()
    seen = add_mail(conn, "already read", priority=5.0, is_read=1)
    mine = add_mail(conn, "my correction", priority=5.0, scored_by="user")
    conn.close()
    assert f.run(factory)["notified"] == 0
    assert f.notes == []
    assert {seen, mine} <= notified_ids(factory)


def test_first_run_marks_existing_mail_without_notifying(factory):
    conn = factory()
    high = [add_mail(conn, f"important {i}", priority=5.0) for i in range(5)]
    backlog = add_mail(conn, "backlog")  # not scored yet
    conn.close()

    f = Fakes()
    f.scores["backlog"] = 5.0  # gets scored later: still old mail, so no pop-up
    result = f.run(factory)
    assert result["notified"] == 0 and f.notes == []
    assert set(high) | {backlog} <= notified_ids(factory)

    f.incoming = [("brand new", 5.0)]
    assert f.run(factory)["notified"] == 1
    assert [n[1] for n in f.notes] == ["brand new"]


def test_first_run_waits_until_there_is_mail(factory):
    f = Fakes()
    assert f.run(factory)["notified"] == 0  # empty inbox (e.g. no accounts.yaml yet)
    f.incoming = [("first sync", 5.0)]
    assert f.run(factory)["notified"] == 0  # this is the real first look at the inbox
    assert f.notes == []


def test_caps_notifications_and_sends_summary(factory):
    f = Fakes()
    baseline(factory, f)
    f.incoming = [(f"urgent {i}", 5.0) for i in range(6)]
    assert f.run(factory)["notified"] == 6
    assert len(f.notes) == runner.MAX_NOTIFICATIONS + 1
    assert f.notes[-1] == ("Unified inbox", "...and 3 more important emails")
    assert f.run(factory)["notified"] == 0
    assert len(f.notes) == 4


# --- notify -------------------------------------------------------------------------

@pytest.fixture
def no_subprocess(monkeypatch):
    def fail(*a, **kw):
        raise AssertionError("subprocess must not run")

    monkeypatch.setattr(notify_mod.subprocess, "run", fail)


def test_notify_disabled(monkeypatch, no_subprocess):
    monkeypatch.setenv("NOTIFICATIONS", "0")
    assert notify_mod.notify("t", "m") is False


@pytest.mark.parametrize("system", ["Linux", "Darwin", "Windows", "FreeBSD"])
def test_notify_without_notifier(monkeypatch, no_subprocess, system):
    monkeypatch.delenv("NOTIFICATIONS", raising=False)
    monkeypatch.setattr(notify_mod.platform, "system", lambda: system)
    monkeypatch.setattr(notify_mod.shutil, "which", lambda name: None)
    assert notify_mod.notify("t", "m") is False


@pytest.fixture
def captured(monkeypatch):
    calls = []

    def fake_run(args, **kw):
        calls.append((args, kw))
        return subprocess.CompletedProcess(args, 0, b"", b"")

    monkeypatch.delenv("NOTIFICATIONS", raising=False)
    monkeypatch.setattr(notify_mod.shutil, "which", lambda name: f"/bin/{name}")
    monkeypatch.setattr(notify_mod.subprocess, "run", fake_run)
    return calls


TITLE = 'Bob "the boss" O\'Neil; $(rm -rf ~) `x`'
TEXT = "-n <b>hi</b> & bye\nline 2"


@pytest.mark.parametrize("system,exe", [("Linux", "notify-send"), ("Darwin", "osascript")])
def test_notify_passes_text_as_plain_arguments(monkeypatch, captured, system, exe):
    monkeypatch.setattr(notify_mod.platform, "system", lambda: system)
    assert notify_mod.notify(TITLE, TEXT) is True
    (args, kw), = captured
    assert args[0] == f"/bin/{exe}"
    assert args[-3:] == ["--", TITLE, TEXT]
    assert not kw.get("shell")
    assert kw["timeout"] == notify_mod.TIMEOUT


def test_notify_windows_uses_env_not_command_line(monkeypatch, captured):
    monkeypatch.setattr(notify_mod.platform, "system", lambda: "Windows")
    assert notify_mod.notify(TITLE, TEXT) is True
    (args, kw), = captured
    assert args[0] == "/bin/powershell"
    assert "-EncodedCommand" in args
    script = base64.b64decode(args[args.index("-EncodedCommand") + 1]).decode("utf-16-le")
    assert script == notify_mod.WINDOWS_SCRIPT
    assert not any(TITLE in a or "boss" in a for a in args)
    assert kw["env"]["INBOX_NOTIFY_TITLE"] == TITLE
    assert kw["env"]["INBOX_NOTIFY_TEXT"] == TEXT


def test_notify_truncates_long_text(monkeypatch, captured):
    monkeypatch.setattr(notify_mod.platform, "system", lambda: "Linux")
    notify_mod.notify("x" * 500, "y\x00" * 500)
    (args, _), = captured
    assert len(args[-2]) == 100 and args[-2].endswith("...")
    assert len(args[-1]) == 300 and "\x00" not in args[-1]


@pytest.mark.parametrize("outcome", ["exit1", "timeout", "oserror"])
def test_notify_failures_return_false(monkeypatch, outcome):
    def fake_run(args, **kw):
        if outcome == "exit1":
            return subprocess.CompletedProcess(args, 1, b"", b"no dbus")
        if outcome == "timeout":
            raise subprocess.TimeoutExpired(args, kw["timeout"])
        raise OSError("exec failed")

    monkeypatch.delenv("NOTIFICATIONS", raising=False)
    monkeypatch.setattr(notify_mod.platform, "system", lambda: "Linux")
    monkeypatch.setattr(notify_mod.shutil, "which", lambda name: "/bin/notify-send")
    monkeypatch.setattr(notify_mod.subprocess, "run", fake_run)
    assert notify_mod.notify("t", "m") is False


# --- scheduler ----------------------------------------------------------------------

@pytest.mark.parametrize("minutes,expected", [(7, 7), (None, 5)])
def test_scheduler_runs_job_now_then_every_n_minutes(monkeypatch, minutes, expected):
    monkeypatch.setattr(scheduler, "SYNC_INTERVAL_MINUTES", 5.0)
    ran = threading.Event()
    sched = scheduler.start_scheduler(job=ran.set, minutes=minutes)
    try:
        job = sched.get_job(scheduler.JOB_ID)
        assert job.trigger.interval == timedelta(minutes=expected)
        assert job.max_instances == 1
        assert job.coalesce is True
        assert ran.wait(5), "first run should happen right after start"
    finally:
        sched.shutdown(wait=False)


# --- launcher (python -m app) ---------------------------------------------------------

SERVERS = []


class FakeServer:

    def __init__(self, config):
        self.config, self.started, self.should_exit = config, False, False
        SERVERS.append(self)

    def run(self):
        self.started = True
        time.sleep(0.2)


@pytest.fixture
def launch(monkeypatch, tmp_path):
    """Run launcher.main() with a fake web app, server, scheduler and browser."""
    state = {"opened": [], "scheduler": None}
    web_main = types.ModuleType("app.web.main")

    def create_app(conn_factory=None, on_sync_now=None):
        state["on_sync_now"] = on_sync_now
        return "fake-asgi-app"

    web_main.create_app = create_app
    monkeypatch.setitem(sys.modules, "app.web", types.ModuleType("app.web"))
    monkeypatch.setitem(sys.modules, "app.web.main", web_main)
    monkeypatch.setitem(sys.modules, "webview", None)  # pywebview not installed
    monkeypatch.setattr(launcher.uvicorn, "Server", FakeServer)
    monkeypatch.setattr(launcher, "_port_in_use", lambda port: False)
    monkeypatch.setattr(launcher.webbrowser, "open", state["opened"].append)
    monkeypatch.setattr(config, "ACCOUNTS_FILE", tmp_path / "accounts.yaml")

    class FakeScheduler:
        stopped = False

        def shutdown(self, wait=True):
            self.stopped = True

    def fake_start():
        state["scheduler"] = FakeScheduler()
        return state["scheduler"]

    monkeypatch.setattr(launcher, "start_scheduler", fake_start)
    SERVERS.clear()

    def run(*argv):
        state["code"] = launcher.main(list(argv))
        return state

    return run


def test_parse_args_defaults():
    args = launcher.parse_args([])
    assert (args.port, args.no_browser, args.window, args.no_scheduler) == (8000, False, False, False)


def test_launcher_serves_on_localhost_only(launch, monkeypatch, capsys):
    state = launch("--port", "8123", "--window")
    assert state["code"] == 0
    server, = SERVERS
    assert server.config.host == "127.0.0.1"
    assert server.config.port == 8123
    assert state["scheduler"].stopped

    deadline = time.monotonic() + 3
    while not state["opened"] and time.monotonic() < deadline:
        time.sleep(0.05)
    assert state["opened"] == ["http://127.0.0.1:8123"]

    out = capsys.readouterr().out
    assert "pywebview" in out  # --window fell back to the browser
    assert "set-password" in out  # no accounts.yaml: setup help instead of a crash
    assert "http://127.0.0.1:8123" in out

    monkeypatch.setattr(launcher, "run_cycle", lambda: {"sync": {}})
    assert state["on_sync_now"]() == {"sync": {}}


def test_launcher_without_scheduler_or_browser(launch, monkeypatch):
    announced = threading.Event()
    monkeypatch.setattr(launcher, "_announce", lambda url, on: announced.set())
    state = launch("--no-scheduler", "--no-browser")
    assert state["code"] == 0
    assert state["scheduler"] is None
    assert announced.wait(3)
    assert state["opened"] == []


def test_launcher_stops_if_port_busy(launch, monkeypatch, capsys):
    monkeypatch.setattr(launcher, "_port_in_use", lambda port: True)
    state = launch()
    assert state["code"] == 1
    assert state["scheduler"] is None
    assert "already in use" in capsys.readouterr().out
