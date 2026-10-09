import base64
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import db
from app.web import auth
from app.web.main import create_app

RFC_SECRET = base64.b32encode(b"12345678901234567890").decode()  # RFC 6238 test key
PASSWORD = "correct horse battery"


def test_totp_matches_rfc6238_vectors():
    assert auth.totp(RFC_SECRET, 59 // 30) == "287082"
    assert auth.totp(RFC_SECRET, 1111111109 // 30) == "081804"
    assert auth.totp(RFC_SECRET, 1234567890 // 30) == "005924"


def test_totp_window_and_replay():
    now = 1_000_000_000
    step = int(now // 30)
    assert auth.check_totp(RFC_SECRET, auth.totp(RFC_SECRET, step), -1, now) == step
    assert auth.check_totp(RFC_SECRET, auth.totp(RFC_SECRET, step - 1), -1, now) == step - 1  # 30 s drift ok
    assert auth.check_totp(RFC_SECRET, auth.totp(RFC_SECRET, step - 2), -1, now) is None
    assert auth.check_totp(RFC_SECRET, auth.totp(RFC_SECRET, step), step, now) is None      # already used
    assert auth.check_totp(RFC_SECRET, "12345", -1, now) is None
    assert auth.check_totp(RFC_SECRET, "", -1, now) is None


def test_password_hash():
    h = auth.hash_password(PASSWORD)
    assert h.startswith("scrypt$") and PASSWORD not in h
    assert auth.verify_password(PASSWORD, h)
    assert not auth.verify_password("wrong", h)
    assert not auth.verify_password(PASSWORD, "garbage")


@pytest.fixture
def site(tmp_path):
    path = tmp_path / "inbox.db"
    db.connect(path).close()
    secret = auth.new_totp_secret()
    app = create_app(conn_factory=lambda: db.connect(path), password_hash=auth.hash_password(PASSWORD),
                     totp_secret=secret)
    client = TestClient(app, follow_redirects=False)
    code = lambda: auth.totp(secret, int(time.time() // 30))  # noqa: E731
    return client, code, path


def login(client, code, password=PASSWORD, remember="", nxt="/"):
    return client.post("/login", data={"password": password, "code": code, "remember": remember, "next": nxt})


def test_everything_needs_login(site):
    client, code, _ = site
    r = client.get("/?view=list")
    assert r.status_code == 303 and r.headers["location"] == "/login?next=%2F%3Fview%3Dlist"
    assert client.get("/api/stats", headers={"Accept": "application/json"}).status_code == 401
    assert client.post("/sync", headers={"Accept": "application/json"}).status_code == 401
    assert client.get("/message/1?partial=1").status_code == 401
    assert client.get("/rules").status_code == 303
    # writing and sending mail too
    for path in ("/compose/send", "/compose/draft", "/outbox/1/undo", "/outbox/1/discard"):
        assert client.post(path, headers={"Accept": "application/json"}).status_code == 401, path
    assert client.get("/api/outbox/1", headers={"Accept": "application/json"}).status_code == 401
    assert client.get("/compose").status_code == 303 and client.get("/sent").status_code == 303
    assert client.get("/static/style.css").status_code == 200       # the login page needs its CSS
    page = client.get("/login")
    assert page.status_code == 200 and 'name="password"' in page.text and 'name="code"' in page.text
    assert page.headers["cache-control"] == "no-store"


def test_login_success_sets_safe_cookie_and_returns_to_page(site):
    client, code, _ = site
    r = login(client, code(), nxt="/?view=list")
    assert r.status_code == 303 and r.headers["location"] == "/?view=list"
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "max-age" not in cookie
    page = client.get("/")
    assert page.status_code == 200 and "Log out" in page.text
    assert page.headers["cache-control"] == "no-store"


def test_remember_me_lasts_30_days(site):
    client, code, _ = site
    r = login(client, code(), remember="1")
    assert f"max-age={30 * 86400}" in r.headers["set-cookie"].lower()


def test_wrong_password_or_code_or_reused_code_fails(site):
    client, code, _ = site
    assert login(client, code(), password="nope nope nope").status_code == 401
    assert login(client, "000000" if code() != "000000" else "111111").status_code == 401
    ok = code()
    assert login(client, ok).status_code == 303
    client.cookies.clear()
    r = login(client, ok)                       # same code again: refused
    assert r.status_code == 401 and "That password or code isn&#39;t right." in r.text


def test_lockout_after_repeated_failures(site):
    client, code, _ = site
    for _ in range(auth.MAX_FAILURES):
        assert login(client, "123456", password="wrong password").status_code == 401
    r = login(client, code())                  # even the right password + code is refused while locked
    assert r.status_code == 429 and "Too many wrong attempts" in r.text


def test_failures_are_counted_per_client_behind_the_local_proxy(site):
    client, code, path = site
    proxied = TestClient(client.app, follow_redirects=False, client=("127.0.0.1", 50000))
    for _ in range(auth.MAX_FAILURES):
        proxied.post("/login", data={"password": "bad", "code": "123456", "next": "/"},
                     headers={"X-Forwarded-For": "6.6.6.6"})
    blocked = proxied.post("/login", data={"password": PASSWORD, "code": code(), "next": "/"},
                           headers={"X-Forwarded-For": "6.6.6.6"})
    assert blocked.status_code == 429
    # someone else (a different real client) is not locked out by the attacker
    ok = proxied.post("/login", data={"password": PASSWORD, "code": code(), "next": "/"},
                      headers={"X-Forwarded-For": "1.2.3.4, 9.9.9.9"})
    assert ok.status_code == 303
    # a client that is NOT the local proxy can't pick its own bucket with a fake header
    for _ in range(auth.MAX_FAILURES):
        client.post("/login", data={"password": "bad", "code": "1", "next": "/"},
                    headers={"X-Forwarded-For": "7.7.7.7"})
    assert client.post("/login", data={"password": "bad", "code": "1", "next": "/"},
                       headers={"X-Forwarded-For": "8.8.8.8"}).status_code == 429


@pytest.mark.parametrize("nxt", ["//evil.com", "https://evil.com", "/\t/evil.com", "\\\\evil.com", "/\\evil.com"])
def test_no_open_redirect_after_login(site, nxt):
    client, code, _ = site
    r = login(client, code(), nxt=nxt)
    assert r.status_code == 303 and r.headers["location"] == "/"


def test_a_plain_form_after_the_session_ended_goes_to_sign_in(site):
    client, _, _ = site
    # no JavaScript: a page of JSON would be a dead end, so back to that page after signing in
    r = client.post("/message/1/score", data={"move": "do"}, headers={"Referer": "http://testserver/?open=1"})
    assert r.status_code == 303 and r.headers["location"] == "/login?next=%2F%3Fopen%3D1"
    r = client.post("/message/1/score", data={"move": "do"}, headers={"Referer": "https://evil.example/x"})
    assert r.status_code == 303 and r.headers["location"] == "/login?next=%2F"


def test_logout_ends_the_session(site):
    client, code, path = site
    login(client, code())
    assert client.get("/").status_code == 200
    r = client.post("/logout")
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert "clear-site-data" not in r.headers  # drafts go (login page), Settings stay
    assert client.get("/").status_code == 303
    conn = db.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    conn.close()


def test_stolen_or_expired_cookie_is_refused(site):
    client, code, path = site
    login(client, code())
    conn = db.connect(path)
    conn.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00+00:00'")
    conn.commit(); conn.close()
    assert client.get("/").status_code == 303
    client.cookies.set(auth.COOKIE, "made-up-token")
    assert client.get("/").status_code == 303


def test_login_off_by_default(tmp_path):
    path = tmp_path / "inbox.db"
    db.connect(path).close()
    client = TestClient(create_app(conn_factory=lambda: db.connect(path), password_hash="", totp_secret=""),
                        follow_redirects=False)
    assert client.get("/").status_code == 200 and "Log out" not in client.get("/").text
    assert client.get("/login").status_code == 303


def test_non_ascii_digits_are_a_normal_failure_not_a_crash(site):
    client, code, _ = site
    r = login(client, "12345\u00b2")
    assert r.status_code == 401
    assert auth.check_totp(RFC_SECRET, "\uff11\uff12\uff13\uff14\uff15\uff16", -1) is None  # full-width digits


def test_right_password_wrong_code_pauses_logins_for_everyone(site):
    client, code, _ = site
    proxied = TestClient(client.app, follow_redirects=False, client=("127.0.0.1", 50000))
    for i in range(auth.MAX_CODE_FAILURES):   # attacker knows the password, rotates addresses
        proxied.post("/login", data={"password": PASSWORD, "code": "000000", "next": "/"},
                     headers={"X-Forwarded-For": f"10.0.0.{i}"})
    r = proxied.post("/login", data={"password": PASSWORD, "code": code(), "next": "/"},
                     headers={"X-Forwarded-For": "10.9.9.9"})
    wrong = proxied.post("/login", data={"password": "not it", "code": "000000", "next": "/"},
                         headers={"X-Forwarded-For": "10.9.9.8"})
    # refused, and indistinguishable from a wrong password (no "your guess was right" signal)
    assert r.status_code == wrong.status_code == 401 and "set-cookie" not in r.headers
    assert r.text.replace("10.9.9.9", "") == wrong.text.replace("10.9.9.8", "")


def test_wrong_passwords_from_many_addresses_do_not_pause_the_owner(site):
    client, code, _ = site
    proxied = TestClient(client.app, follow_redirects=False, client=("127.0.0.1", 50000))
    for i in range(30):                        # strangers without the password can't lock you out
        proxied.post("/login", data={"password": "guess", "code": "000000", "next": "/"},
                     headers={"X-Forwarded-For": f"10.1.0.{i}"})
    assert proxied.post("/login", data={"password": PASSWORD, "code": code(), "next": "/"},
                        headers={"X-Forwarded-For": "10.2.0.1"}).status_code == 303


def test_ipv6_addresses_in_one_64_share_a_lockout(site):
    client, code, _ = site
    proxied = TestClient(client.app, follow_redirects=False, client=("127.0.0.1", 50000))
    for i in range(auth.MAX_FAILURES):
        proxied.post("/login", data={"password": "bad", "code": "1", "next": "/"},
                     headers={"X-Forwarded-For": f"2001:db8:1:2::{i + 1:x}"})
    r = proxied.post("/login", data={"password": "bad", "code": "1", "next": "/"},
                     headers={"X-Forwarded-For": "2001:db8:1:2:ffff::99"})
    assert r.status_code == 429


def test_same_code_in_parallel_makes_only_one_session(site):
    client, code, path = site
    ok = code()
    results = []

    def go():
        c = TestClient(client.app, follow_redirects=False)
        results.append(login(c, ok).status_code)
    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results).count(303) == 1
    conn = db.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
    conn.close()


def test_logout_with_expired_session_just_goes_to_login(site):
    client, code, _ = site
    client.cookies.set(auth.COOKIE, "expired-or-made-up")
    r = client.post("/logout")
    assert r.status_code == 303 and r.headers["location"] == "/login"


def test_oversized_login_post_is_refused_before_parsing(site):
    client, code, _ = site
    r = client.post("/login", data={"password": "x" * 20000, "code": "1", "next": "/"})
    assert r.status_code == 413
    assert login(client, code()).status_code == 303   # a normal form still works


def test_ipv4_mapped_clients_are_not_lumped_together(site):
    client, code, _ = site
    proxied = TestClient(client.app, follow_redirects=False, client=("127.0.0.1", 50000))
    for _ in range(auth.MAX_FAILURES):
        proxied.post("/login", data={"password": "bad", "code": "1", "next": "/"},
                     headers={"X-Forwarded-For": "::ffff:6.6.6.6"})
    ok = proxied.post("/login", data={"password": PASSWORD, "code": code(), "next": "/"},
                      headers={"X-Forwarded-For": "::ffff:1.2.3.4"})
    assert ok.status_code == 303


def test_dotenv_values_are_taken_literally(tmp_path):
    from dotenv import dotenv_values
    from app import config
    env = tmp_path / ".env"
    config._write_env("IMAP_PASSWORD_X", "pa${HOME}ss$1", path=env)
    assert dotenv_values(env, interpolate=False)["IMAP_PASSWORD_X"] == "pa${HOME}ss$1"
