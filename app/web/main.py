"""The dashboard (steps 2, 4, 5): Eisenhower matrix and list views, message pane,
score corrections and sender rules.

Pages are rendered on the server with Jinja2; static/app.js only saves full reloads, so
every action also works as a plain form post. Build the app with create_app() (nothing
touches the database at import time):

    uvicorn.run(create_app(on_sync_now=...), host="127.0.0.1", port=8000)
"""

import ipaddress
import json
import logging
import re
import sqlite3
import threading
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

import jinja2
from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import config, db
from app.ai.scoring import QUADRANTS, quadrant
from app.web import auth

log = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE / "static"

LIST_LIMIT = 300  # emails in the list view
COLUMN_LIMIT = 100  # emails per matrix column
GROUPS = tuple(QUADRANTS)  # do, schedule, quick, later
ACTIONS = {"do": "Do now", "schedule": "Schedule", "quick": "Quick reply", "later": "Later"}
MOVES = {"do": (5, 5), "schedule": (5, 2), "quick": (2, 5), "later": (2, 2)}
RULE_KINDS = {
    "vip": "Always important (VIP)",
    "low": "Always low priority",
    "private": "Private — never send to AI",
}
SCORED_BY = {"rule": "a rule", "gemma": "Gemma", "user": "you"}
SEARCH_FIELDS = ("subject", "from_email", "from_name", "snippet")
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver", *config.ALLOWED_HOSTS]
FLASH_COOKIE = "flash"
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")

COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}")
CATEGORY_RE = re.compile(r"[a-z0-9][a-z0-9 _-]{0,29}")
PATTERN_RE = re.compile(r"[^@\s]*@[^@\s]+\.[^@\s]+")

CARD_COLUMNS = """SELECT m.id, m.message_id, m.from_name, m.from_email, m.subject, m.snippet,
    m.received_at, m.is_read, m.has_attachments, m.importance, m.urgency, m.category,
    m.action_needed, m.deadline, m.summary, m.reason, m.priority_score, m.scored_by,
    a.label AS account_label, a.email AS account_email, a.color AS account_color"""
FROM = " FROM messages m JOIN accounts a ON a.id = m.account_id"
ORDER = " ORDER BY m.priority_score IS NULL, m.priority_score DESC, m.received_at DESC, m.id DESC"

FormStr = Annotated[str | None, Form()]
NextField = Annotated[str | None, Form(alias="next")]


@dataclass
class Filters:
    """What the inbox page shows; kept in the query string across views."""

    view: str = "matrix"
    account: str = ""
    q: str = ""
    unread: bool = False
    category: str = ""
    unsorted: bool = False  # ?sorted=no: only mail the AI has not sorted yet

    @classmethod
    def from_query(cls, params) -> "Filters":
        return cls(
            view="list" if params.get("view") == "list" else "matrix",
            account=params.get("account", "").strip(),
            q=params.get("q", "").strip()[:200],
            unread=params.get("unread", "") in ("1", "on", "true"),
            category=params.get("category", "").strip(),
            unsorted=params.get("sorted", "") == "no",
        )

    @property
    def active(self) -> bool:
        return bool(self.account or self.q or self.unread or self.category or self.unsorted)

    def url(self, **changes) -> str:
        """Inbox URL with these filters, overridden by `changes`; empty values are dropped."""
        params = {"view": self.view, "account": self.account, "q": self.q,
                  "unread": "1" if self.unread else "", "category": self.category,
                  "sorted": "no" if self.unsorted else "", **changes}
        if params["view"] == "matrix":
            params["view"] = ""
        params = {k: v for k, v in params.items() if v not in ("", None, False)}
        return "/?" + urlencode(params) if params else "/"

    def where(self) -> tuple[str, list]:
        clauses, args = [], []
        if self.account:
            clauses.append("a.email = ?")
            args.append(self.account)
        if self.q:
            like = "%" + _like_escape(self.q) + "%"
            clauses.append("(" + " OR ".join(f"m.{c} LIKE ? ESCAPE '\\'" for c in SEARCH_FIELDS) + ")")
            args += [like] * len(SEARCH_FIELDS)
        if self.unread:
            clauses.append("m.is_read = 0")
        if self.category:
            clauses.append("m.category = ?")
            args.append(self.category)
        if self.unsorted:
            clauses.append("(m.importance IS NULL OR m.urgency IS NULL)")
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), args


def _like_escape(text: str) -> str:
    return re.sub(r"([\\%_])", r"\\\1", text)


def gmail_url(account_email: str | None, message_id: str | None) -> str | None:
    """Deep link that opens this exact email in Gmail (only for Gmail accounts)."""
    if not account_email or not message_id:
        return None
    if not account_email.lower().endswith(("@gmail.com", "@googlemail.com")):
        return None
    mid = message_id.strip().strip("<>")
    return (f"https://mail.google.com/mail/u/{quote(account_email, safe='@')}"
            f"/#search/rfc822msgid:{quote(mid, safe='')}")


# --- formatting helpers ---------------------------------------------------------------

def _color(value: str | None) -> str:
    return value if value and COLOR_RE.fullmatch(value) else "#5f6368"


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _when(ts: str | None) -> tuple[str, str]:
    """Short and long local-time labels for a stored UTC timestamp."""
    d = _parse_ts(ts)
    if d is None:
        return ts or "", ts or ""
    d, now = d.astimezone(), datetime.now().astimezone()
    if d.date() == now.date():
        short = f"{d:%H:%M}"
    elif d.year == now.year:
        short = f"{d:%b} {d.day}"
    else:
        short = f"{d:%b} {d.day}, {d.year}"
    return short, f"{d:%a, %b} {d.day} {d.year}, {d:%H:%M}"


def _ago(ts: str | None) -> str | None:
    d = _parse_ts(ts)
    if d is None:
        return None
    secs = (datetime.now(timezone.utc) - d).total_seconds()
    if secs < 60:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)} min ago"
    if secs < 86400:
        return f"{int(secs // 3600)} h ago"
    return f"{int(secs // 86400)} d ago"


def _due(deadline) -> dict | None:
    """Deadline badge; 'soon' within 2 days, 'late' once passed."""
    if not deadline:
        return None
    try:
        d = date.fromisoformat(str(deadline)[:10])
    except ValueError:
        return {"text": f"due {deadline}", "cls": ""}
    days, label = (d - date.today()).days, f"{d:%b} {d.day}"
    if days < 0:
        return {"text": f"overdue · {label}", "cls": "late"}
    text = "due today" if days == 0 else "due tomorrow" if days == 1 else f"due {label}"
    return {"text": text, "cls": "soon" if days <= 2 else ""}


def _describe(value) -> str:
    if isinstance(value, dict):
        return ", ".join(f"{k}: {_describe(v)}" for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return ", ".join(_describe(v) for v in value)
    return str(value)


def _cycle_summary(result: dict) -> tuple[str, bool]:
    """Readable text for a runner.run_cycle() result, and whether it went cleanly."""
    if result.get("status") == "already running":
        return "A sync is already running, try again in a moment", False
    parts = []
    sync = result.get("sync")
    if isinstance(sync, dict):
        new = sum(v for v in sync.values() if isinstance(v, int))
        parts.append(f"{new} new email{'s' if new != 1 else ''}")
    classify = result.get("classify")
    if isinstance(classify, dict):
        parts.append(f"{classify.get('rule_scored', 0) + classify.get('ai_scored', 0)} sorted")
        if classify.get("skipped_budget"):
            parts.append(f"{classify['skipped_budget']} waiting for the AI")
    text = "Sync done: " + (", ".join(parts) or "nothing new")
    if result.get("error"):
        return f"{text}. Problem: {result['error']}", False
    return text, True


def _sync_summary(result) -> str:
    if isinstance(result, dict):
        text = "; ".join(f"{k}: {_describe(v)}" for k, v in result.items()) or "nothing new"
    else:
        text = _describe(result) or "done"
    return text if len(text) <= 300 else text[:299] + "…"


def _level(value) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 5 else None


def _rule_pattern(raw: str | None) -> str | None:
    """'Boss@Corp.com' -> 'boss@corp.com'; 'corp.com' or '@corp.com' -> '@corp.com'."""
    p = (raw or "").strip().lower()
    if p and "@" not in p:
        p = "@" + p
    return p if PATTERN_RE.fullmatch(p) else None


def _safe_next(url: str | None, default: str = "/") -> str:
    """Only redirect within this site."""
    # browsers drop tabs/newlines, so "/\t/evil.com" would become "//evil.com": refuse them all
    if (url and url.startswith("/") and not url.startswith("//") and "\\" not in url
            and not any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in url)):
        return url
    return default


def _without_param(url: str, name: str) -> str:
    parts = urlsplit(url)
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k != name])
    return parts.path + ("?" + query if query else "")


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --- queries --------------------------------------------------------------------------

def _card(row) -> dict:
    """A message row plus everything the templates need to show it."""
    m = dict(row)
    m["quad"] = quadrant(m["importance"], m["urgency"])
    m["sender"] = m["from_name"] or m["from_email"] or "(unknown sender)"
    m["color"] = _color(m.get("account_color"))
    m["when"], m["when_full"] = _when(m["received_at"])
    m["due"] = _due(m["deadline"])
    m["scored_by_label"] = SCORED_BY.get(m["scored_by"] or "", m["scored_by"])
    return m


def _fetch(conn, where: str, args: list, extra: str = "", extra_args: list = (),
           limit: int = LIST_LIMIT) -> list[dict]:
    sql = CARD_COLUMNS + FROM + where
    if extra:
        sql += (" AND " if where else " WHERE ") + "(" + extra + ")"
    rows = conn.execute(sql + ORDER + " LIMIT ?", [*args, *extra_args, limit]).fetchall()
    return [_card(r) for r in rows]


def _counts(conn, where: str = "", args: list = ()) -> tuple[dict, dict]:
    """Totals per quadrant plus unread/unscored, and which (importance, urgency) pairs
    land in each quadrant (so scoring.quadrant stays the only place that decides)."""
    stats = {"total": 0, "unread": 0, "unscored": 0, "unread_do": 0,
             "quadrants": dict.fromkeys(GROUPS, 0), "quadrant_unread": dict.fromkeys(GROUPS, 0)}
    pairs: dict[str, set] = {k: set() for k in GROUPS}
    sql = "SELECT m.importance, m.urgency, m.is_read, COUNT(*) AS n" + FROM + where + " GROUP BY 1, 2, 3"
    for r in conn.execute(sql, args):
        q, n = quadrant(r["importance"], r["urgency"]), r["n"]
        stats["total"] += n
        stats["unread"] += 0 if r["is_read"] else n
        if q is None:
            stats["unscored"] += n
            continue
        stats["quadrants"][q] += n
        stats["quadrant_unread"][q] += 0 if r["is_read"] else n
        pairs[q].add((r["importance"], r["urgency"]))
        if q == "do" and not r["is_read"]:
            stats["unread_do"] += n
    return stats, pairs


def _matrix(conn, f: Filters) -> tuple[list[dict], dict, int]:
    where, args = f.where()
    stats, pairs = _counts(conn, where, args)
    columns = []
    for key in GROUPS:
        found = sorted(pairs[key])
        cards = []
        if found:
            cond = " OR ".join("(m.importance = ? AND m.urgency = ?)" for _ in found)
            cards = _fetch(conn, where, args, cond, [v for p in found for v in p], COLUMN_LIMIT)
        columns.append({"key": key, "title": QUADRANTS[key], "action": ACTIONS[key],
                        "cards": cards, "total": stats["quadrants"][key],
                        "unread": stats["quadrant_unread"][key]})
    unsorted = {"key": "unsorted", "total": stats["unscored"], "cards": []}
    if stats["unscored"]:
        unsorted["cards"] = _fetch(conn, where, args, "m.importance IS NULL OR m.urgency IS NULL",
                                   [], COLUMN_LIMIT)
    return columns, unsorted, stats["total"]


def _categories(conn, f: Filters | None = None) -> list[str]:
    """Categories in the database; with filters, only those that still have mail under the
    other filters (so the Category menu never offers a dead end)."""
    where, args = (Filters(account=f.account, q=f.q, unread=f.unread, unsorted=f.unsorted).where()
                   if f else ("", []))
    cond = "m.category IS NOT NULL AND m.category != ''"
    sql = "SELECT DISTINCT m.category" + FROM + (where + " AND " if where else " WHERE ") + cond
    return [r[0] for r in conn.execute(sql + " ORDER BY 1", args)]


def _detail(conn, message_id: int) -> dict | None:
    row = db.get_message(conn, message_id)
    if row is None:
        return None
    m = _card(row)
    m["gmail_url"] = gmail_url(m["account_email"], m["message_id"])
    sender = (m["from_email"] or "").lower()
    m["domain"] = sender.rsplit("@", 1)[1] if "@" in sender else ""
    m["rules"] = conn.execute("SELECT * FROM rules WHERE pattern IN (?, ?) ORDER BY kind",
                              (sender, "@" + m["domain"])).fetchall() if sender else []
    return m


def _rule_matches(conn, pattern: str) -> int:
    if pattern.startswith("@"):
        sql, arg = "from_email LIKE ? ESCAPE '\\'", "%" + _like_escape(pattern)
    else:
        sql, arg = "from_email = ? COLLATE NOCASE", pattern
    return conn.execute("SELECT COUNT(*) FROM messages WHERE " + sql, (arg,)).fetchone()[0]


def _utc_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _page(request: Request, conn, f: Filters, **extra) -> dict:
    """Context every full page needs: header, filter chips, status strip, title badge."""
    accounts = []
    for a in db.list_accounts(conn):
        d = dict(a)
        d["color"] = _color(a["color"])
        d["synced_ago"] = _ago(a["last_synced_at"])
        d["synced_full"] = _when(a["last_synced_at"])[1] if a["last_synced_at"] else "never"
        accounts.append(d)
    unread = {r[0]: r[1] for r in conn.execute(
        "SELECT a.email, COUNT(*)" + FROM + " WHERE m.is_read = 0 GROUP BY a.email")}
    chips, seen = [], set()
    for a in accounts:  # one chip per address, even if several folders are synced
        if a["email"] not in seen:
            seen.add(a["email"])
            chips.append({"email": a["email"], "label": a["label"], "color": a["color"],
                          "unread": unread.get(a["email"], 0)})
    return {
        "f": f, "accounts": accounts, "chips": chips, "stats": _counts(conn)[0],
        "categories": _categories(conn, f), "ai_calls": db.ai_calls_today(conn, _utc_day()),
        "ai_max": config.MAX_AI_CALLS_PER_DAY,
        "here": request.url.path + (f"?{request.url.query}" if request.url.query else ""),
        **extra,
    }


# --- responses ------------------------------------------------------------------------

def _wants_json(request: Request) -> bool:
    return "application/json" in request.headers.get("accept", "")


def _reply(request: Request, message: str, next_url: str | None, ok: bool = True,
           status: int | None = None, **data):
    """JSON for fetch() callers; otherwise redirect back (POST-redirect-GET) with a flash."""
    if _wants_json(request):
        body = json.loads(json.dumps({"ok": ok, "message": message, **data}, default=str))
        return JSONResponse(body, status_code=status or (200 if ok else 400))
    resp = RedirectResponse(_safe_next(next_url), status_code=303)
    resp.set_cookie(FLASH_COOKIE, quote(("ok:" if ok else "err:") + message), max_age=60,
                    httponly=True, samesite="strict")
    return resp


def _pop_flash(request: Request) -> dict | None:
    raw = request.cookies.get(FLASH_COOKIE)
    if not raw:
        return None
    kind, _, text = unquote(raw).partition(":")
    return {"kind": "ok" if kind == "ok" else "err", "text": text[:500]}


def _static_version() -> str:
    """Changes whenever a static file changes, so browsers never use a stale copy."""
    return str(int(max((p.stat().st_mtime for p in STATIC_DIR.iterdir()), default=0)))


# --- the app --------------------------------------------------------------------------

def _client(request: Request) -> str:
    """Who is trying to log in: behind a local proxy (tailscale serve/funnel) the last
    X-Forwarded-For entry is the one the proxy added; otherwise the socket address."""
    host = request.client.host if request.client else ""
    if host in ("127.0.0.1", "::1"):
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd.strip():
            host = fwd.split(",")[-1].strip()[:64]
    try:  # one IPv6 user owns a whole /64: count it as one client
        ip = ipaddress.ip_address(host)
        if ip.version == 6:
            return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    except ValueError:
        pass
    return host or "unknown"


def _secure_cookie(request: Request) -> bool:
    host = (request.headers.get("host") or "").split(":")[0]
    return (request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
            or bool(config.ALLOWED_HOSTS) or host not in ("127.0.0.1", "localhost", "testserver"))


def create_app(conn_factory: Callable[[], sqlite3.Connection] = db.connect,
               on_sync_now: Callable[[], dict] | None = None,
               password_hash: str | None = None, totp_secret: str | None = None) -> FastAPI:
    """conn_factory() opens a new SQLite connection (one per request, closed afterwards).
    on_sync_now() runs a sync + AI pass and returns a dict of results for the status line;
    without it the Sync button just says sync is not available."""
    password_hash = config.DASHBOARD_PASSWORD_HASH if password_hash is None else password_hash
    totp_secret = config.DASHBOARD_TOTP_SECRET if totp_secret is None else totp_secret
    login_on = bool(password_hash)
    app = FastAPI(title="Unified Inbox", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)  # no DNS rebinding
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    env = jinja2.Environment(loader=jinja2.FileSystemLoader(HERE / "templates"), autoescape=True)
    env.globals.update(QUADRANTS=QUADRANTS, ACTIONS=ACTIONS, RULE_KINDS=RULE_KINDS,
                       static_v=_static_version(), login_on=login_on, totp_on=bool(totp_secret))
    templates = Jinja2Templates(env=env)
    sync_lock = threading.Lock()
    # one login check at a time: no racing past the lockout or reusing a code in parallel,
    # and at most one ~16 MB scrypt in memory on a 1 GB VM
    login_lock = threading.Lock()

    def connect():
        return closing(conn_factory())

    def render(request: Request, name: str, ctx: dict, status: int = 200):
        flash = _pop_flash(request)
        resp = templates.TemplateResponse(request, name, {**ctx, "flash": flash}, status_code=status)
        if flash:
            resp.delete_cookie(FLASH_COOKIE)
        return resp

    @app.middleware("http")
    async def guard(request: Request, call_next):
        # Any web page you visit could post a form to localhost; only accept our own.
        origin = request.headers.get("origin")
        if (request.method not in ("GET", "HEAD") and origin
                and urlsplit(origin).netloc != request.headers.get("host")
                # behind `tailscale serve` the Host may be rewritten; trust only configured names
                and (urlsplit(origin).hostname or "") not in config.ALLOWED_HOSTS):
            return PlainTextResponse("Cross-site request blocked", status_code=403)
        path = request.url.path
        if login_on and path not in ("/login", "/logout") and not path.startswith("/static/"):
            with connect() as conn:
                signed_in = auth.session_valid(conn, request.cookies.get(auth.COOKIE))
            if not signed_in:
                if request.method in ("GET", "HEAD") and not _wants_json(request) \
                        and "partial" not in request.query_params:
                    target = path + (f"?{request.url.query}" if request.url.query else "")
                    return RedirectResponse("/login?" + urlencode({"next": target}), status_code=303)
                return JSONResponse({"ok": False, "message": "Please sign in again", "login": "/login"},
                                    status_code=401)
        resp = await call_next(request)
        if not path.startswith("/static/"):
            # nothing with email in it is kept by the browser (back button on a shared computer)
            resp.headers.setdefault("Cache-Control", "no-store")
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        # same-origin, not no-referrer: under no-referrer browsers send `Origin: null` with
        # plain form posts, which the guard above has to reject (that broke every no-JS form)
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        if "text/html" in request.headers.get("accept", ""):
            return templates.TemplateResponse(
                request, "error.html", {"status": exc.status_code, "detail": exc.detail},
                status_code=exc.status_code)
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    # --- login (only when DASHBOARD_PASSWORD_HASH is set) ----------------------------------
    def login_page(request: Request, nxt: str, error: str = "", status: int = 200):
        return templates.TemplateResponse(request, "login.html",
                                          {"next": nxt, "error": error}, status_code=status)

    @app.get("/login")
    def login_form(request: Request, next_url: Annotated[str, Query(alias="next")] = "/"):
        nxt = _safe_next(next_url)
        if not login_on:
            return RedirectResponse(nxt, status_code=303)
        with connect() as conn:
            if auth.session_valid(conn, request.cookies.get(auth.COOKIE)):
                return RedirectResponse(nxt, status_code=303)
        return login_page(request, nxt)

    @app.post("/login")
    def login(request: Request, password: FormStr = None, code: FormStr = None,
              remember: FormStr = None, next_url: NextField = None):
        nxt = _safe_next(next_url)
        if not login_on:
            return RedirectResponse(nxt, status_code=303)
        client = _client(request)
        with login_lock, connect() as conn:
            wait = auth.locked_minutes(conn, client)
            paused = auth.locked_minutes(conn, auth.CODE_GUARD, auth.MAX_CODE_FAILURES)
            if wait or paused:
                left = max(wait, paused)
                return login_page(request, nxt, f"Too many wrong attempts. Try again in {left} "
                                                f"minute{'s' if left != 1 else ''}.", 429)
            ok_pw = auth.verify_password((password or "")[:1024], password_hash)
            counter = None
            if totp_secret:
                counter = auth.check_totp(totp_secret, (code or "")[:32], auth.last_totp_counter(conn))
            if not ok_pw or (totp_secret and counter is None):
                auth.record_failure(conn, client)
                if ok_pw:  # someone has the password but not the phone: pause logins for everyone
                    auth.record_failure(conn, auth.CODE_GUARD)
                    log.error("correct password but wrong 2-step code from %s: consider "
                              "changing the password (python -m app.cli set-login)", client)
                conn.commit()
                log.warning("failed login from %s", client)
                what = "password or code" if totp_secret else "password"
                return login_page(request, nxt, f"That {what} isn't right.", 401)
            auth.clear_failures(conn, client)
            if counter is not None:
                auth.save_totp_counter(conn, counter)
            token, _ = auth.create_session(conn, bool(remember),
                                           request.headers.get("user-agent", ""))
            conn.commit()
        resp = RedirectResponse(nxt, status_code=303)
        resp.set_cookie(auth.COOKIE, token, httponly=True, samesite="lax", path="/",
                        secure=_secure_cookie(request),
                        max_age=auth.REMEMBER_DAYS * 86400 if remember else None)
        return resp

    @app.post("/logout")
    def logout(request: Request):
        with connect() as conn:
            auth.end_session(conn, request.cookies.get(auth.COOKIE))
            conn.commit()
        resp = RedirectResponse("/login" if login_on else "/", status_code=303)
        resp.delete_cookie(auth.COOKIE, path="/")
        return resp

    @app.get("/")
    def index(request: Request):
        f = Filters.from_query(request.query_params)
        open_id = _int(request.query_params.get("open"))
        with connect() as conn:
            ctx = _page(request, conn, f, page=f.view, open_id=open_id, msg=None)
            if f.view == "list":
                where, args = f.where()
                ctx["cards"] = _fetch(conn, where, args, limit=LIST_LIMIT)
                ctx["total"] = conn.execute("SELECT COUNT(*)" + FROM + where, args).fetchone()[0]
            else:
                ctx["columns"], ctx["unsorted"], ctx["total"] = _matrix(conn, f)
            if open_id is not None:
                ctx.update(msg=_detail(conn, open_id), next_url=f.url(open=open_id),
                           close_url=f.url())
        return render(request, "index.html", ctx)

    @app.get("/message/{message_id}")
    def message(request: Request, message_id: int, partial: str = "", mark_read: str = "",
                next_url: Annotated[str, Query(alias="next")] = ""):
        with connect() as conn:
            # the user opened it in the pane. The custom header can't be sent by another site's
            # link or form, so a cross-site GET can't mark (and so hide) mail as read.
            if mark_read == "1" and partial and request.headers.get("x-inbox-open") == "1":
                row = conn.execute("SELECT is_read FROM messages WHERE id = ?", (message_id,)).fetchone()
                if row is not None and not row["is_read"]:
                    db.set_read(conn, message_id, True)
                    conn.commit()
            msg = _detail(conn, message_id)
            if msg is None:
                raise HTTPException(404, "Message not found")
            if partial:  # fragment for the side pane
                nxt = _safe_next(next_url, f"/message/{message_id}")
                ctx = {"msg": msg, "next_url": nxt, "close_url": _without_param(nxt, "open"),
                       "categories": _categories(conn)}
                return templates.TemplateResponse(request, "_detail.html", ctx)
            ctx = _page(request, conn, Filters(), page="message", msg=msg, standalone=True,
                        next_url=f"/message/{message_id}")
        return render(request, "message.html", ctx)

    @app.post("/message/{message_id}/read")
    def mark_read(request: Request, message_id: int, is_read: FormStr = None,
                  next_url: NextField = None):
        with connect() as conn:
            row = conn.execute("SELECT is_read FROM messages WHERE id = ?", (message_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "Message not found")
            if is_read in (None, ""):
                value = not row["is_read"]
            else:
                value = is_read.strip().lower() in ("1", "true", "on", "yes")
            db.set_read(conn, message_id, value)
            conn.commit()
        return _reply(request, "Marked as read" if value else "Marked as unread", next_url,
                      is_read=value)

    @app.post("/message/{message_id}/score")
    def rescore(request: Request, message_id: int, importance: FormStr = None,
                urgency: FormStr = None, category: FormStr = None, move: FormStr = None,
                next_url: NextField = None):
        if move:
            if move not in MOVES:
                return _reply(request, f"Unknown bucket: {move}", next_url, ok=False)
            imp, urg = MOVES[move]
        else:
            imp, urg = _level(importance), _level(urgency)
            if imp is None or urg is None:
                return _reply(request, "Importance and urgency must be whole numbers from 1 to 5",
                              next_url, ok=False)
        cat = (category or "").strip().lower() or None
        if cat and not CATEGORY_RE.fullmatch(cat):
            return _reply(request, "Category: up to 30 letters, digits, spaces, - or _",
                          next_url, ok=False)
        with connect() as conn:
            try:
                db.record_feedback(conn, message_id, imp, urg, cat)
            except KeyError:
                raise HTTPException(404, "Message not found") from None
            conn.commit()
        q = quadrant(imp, urg)
        return _reply(request, f"Moved to “{ACTIONS[q]}”. Future scores will learn from this.",
                      next_url, importance=imp, urgency=urg, quadrant=q)

    @app.get("/rules")
    def rules_page(request: Request):
        with connect() as conn:
            rules: dict[str, list] = {k: [] for k in RULE_KINDS}
            for r in db.list_rules(conn):
                rules.setdefault(r["kind"], []).append(
                    {**dict(r), "matches": _rule_matches(conn, r["pattern"])})
            ctx = _page(request, conn, Filters(), page="rules", rules=rules)
        return render(request, "rules.html", ctx)

    @app.post("/rules")
    def add_rule(request: Request, kind: FormStr = None, pattern: FormStr = None,
                 next_url: NextField = None):
        next_url = next_url or "/rules"
        if kind not in RULE_KINDS:
            return _reply(request, "Pick a rule type", next_url, ok=False)
        p = _rule_pattern(pattern)
        if p is None:
            if urlsplit(_safe_next(next_url)).path == "/rules":  # keep what was typed (no-JS path)
                next_url = "/rules?" + urlencode({"pattern": (pattern or "")[:200], "kind": kind})
            return _reply(request, "Enter a sender address (boss@company.com) or a domain "
                                   "(@company.com)", next_url, ok=False)
        with connect() as conn:
            db.add_rule(conn, kind, p)
            conn.commit()
        return _reply(request, f"Rule saved: {RULE_KINDS[kind]} for {p}. "
                               "It also sorts mail that's still waiting.",
                      next_url, kind=kind, pattern=p)

    @app.post("/rules/{rule_id}/delete")
    def delete_rule(request: Request, rule_id: int, next_url: NextField = None):
        with connect() as conn:
            db.delete_rule(conn, rule_id)
            conn.commit()
        return _reply(request, "Rule removed", next_url or "/rules")

    @app.post("/sync")
    def sync_now(request: Request, next_url: NextField = None):
        if on_sync_now is None:
            return _reply(request, "Sync not available here. Run: python -m app.cli sync",
                          next_url, ok=False, status=503)
        if not sync_lock.acquire(blocking=False):
            return _reply(request, "A sync is already running", next_url, ok=False, status=409)
        try:
            result = on_sync_now()
        except Exception as exc:  # noqa: BLE001
            log.exception("sync failed")
            return _reply(request, f"Sync failed: {exc}", next_url, ok=False, status=500)
        finally:
            sync_lock.release()
        if isinstance(result, dict) and ("classify" in result or "status" in result):
            text, ok = _cycle_summary(result)
            return _reply(request, text, next_url, ok=ok, status=200, result=result)
        return _reply(request, "Sync done. " + _sync_summary(result), next_url, result=result)

    @app.get("/api/stats")
    def api_stats():
        with connect() as conn:
            stats = _counts(conn)[0]
            stats.update(ai_calls_today=db.ai_calls_today(conn, _utc_day()),
                         ai_calls_max=config.MAX_AI_CALLS_PER_DAY)
        return stats

    return app
