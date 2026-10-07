"""Optional login: password + 6-digit authenticator code (TOTP), server-side sessions,
and a lockout after repeated failures. Off unless DASHBOARD_PASSWORD_HASH is set in .env
(python -m app.cli set-login does that)."""

import base64
import hashlib
import hmac
import secrets
import struct
import time
from datetime import datetime, timedelta, timezone

COOKIE = "inbox_session"
REMEMBER_DAYS = 30
SHORT_HOURS = 12            # "don't remember this device": cookie dies with the browser, server after 12h
MAX_FAILURES = 10           # per client, per window; with 2FA, guessing stays hopeless
MAX_CODE_FAILURES = 5       # right password, wrong code: from ANY client, then logins pause
FAIL_WINDOW_MIN = 15
CODE_GUARD = "*right-password-wrong-code*"  # pseudo-client that counts those across everyone
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1   # ~16 MB, ~50 ms: fine on a 1 GB VM


# --- password hashing ---------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt, digest = stored.split("$")
        if kind != "scrypt":
            return False
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt),
                             n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


# --- authenticator codes (RFC 6238, 30-second steps, 6 digits) -----------------------------

def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def totp(secret: str, counter: int) -> str:
    mac = hmac.new(_key(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def check_totp(secret: str, code: str, last_counter: int, now: float | None = None) -> int | None:
    """The matching time step (allowing ±30 s of clock drift), or None. A step at or before
    `last_counter` is refused so a code can't be used twice."""
    code = "".join(ch for ch in (code or "") if ch in "0123456789")  # ASCII only ("²" isdigit too)
    if len(code) != 6:
        return None
    current = int((now if now is not None else time.time()) // 30)
    for counter in (current - 1, current, current + 1):
        if counter > last_counter and hmac.compare_digest(totp(secret, counter), code):
            return counter
    return None


def otpauth_uri(secret: str, account: str = "inbox") -> str:
    return f"otpauth://totp/Unified%20Inbox:{account}?secret={secret}&issuer=Unified%20Inbox"


# --- sessions and failed attempts (SQLite) -------------------------------------------------

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_session(conn, remember: bool, user_agent: str = "") -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires = _now() + (timedelta(days=REMEMBER_DAYS) if remember else timedelta(hours=SHORT_HOURS))
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (_now().isoformat(),))
    conn.execute(
        "INSERT INTO sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)",
        (_hash_token(token), _now().isoformat(), expires.isoformat(), user_agent[:200]),
    )
    return token, expires


def session_valid(conn, token: str | None) -> bool:
    if not token:
        return False
    row = conn.execute("SELECT expires_at FROM sessions WHERE token_hash = ?",
                       (_hash_token(token),)).fetchone()
    return bool(row) and row["expires_at"] > _now().isoformat()


def end_session(conn, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def end_all_sessions(conn) -> int:
    return conn.execute("DELETE FROM sessions").rowcount


def locked_minutes(conn, client: str, limit: int = MAX_FAILURES) -> int:
    """Minutes until this client may try again (0 = not locked)."""
    since = (_now() - timedelta(minutes=FAIL_WINDOW_MIN)).isoformat()
    rows = conn.execute("SELECT at FROM login_failures WHERE client = ? AND at > ? ORDER BY at",
                        (client, since)).fetchall()
    if len(rows) < limit:
        return 0
    oldest = datetime.fromisoformat(rows[-limit]["at"])
    left = oldest + timedelta(minutes=FAIL_WINDOW_MIN) - _now()
    return max(1, int(left.total_seconds() // 60) + 1)


def record_failure(conn, client: str) -> None:
    conn.execute("DELETE FROM login_failures WHERE at < ?",
                 ((_now() - timedelta(days=1)).isoformat(),))
    conn.execute("INSERT INTO login_failures (client, at) VALUES (?, ?)", (client, _now().isoformat()))


def clear_failures(conn, client: str) -> None:
    conn.execute("DELETE FROM login_failures WHERE client = ?", (client,))


def last_totp_counter(conn) -> int:
    row = conn.execute("SELECT value FROM auth_state WHERE key = 'totp_counter'").fetchone()
    return int(row["value"]) if row else -1


def save_totp_counter(conn, counter: int) -> None:
    conn.execute("INSERT INTO auth_state (key, value) VALUES ('totp_counter', ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(counter),))
