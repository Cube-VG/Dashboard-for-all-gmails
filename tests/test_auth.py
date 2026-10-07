import base64
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


def test_logout_ends_the_session(site):
    client, code, path = site
    login(client, code())
    assert client.get("/").status_code == 200
    r = client.post("/logout")
    assert r.status_code == 303 and r.headers["location"] == "/login"
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
