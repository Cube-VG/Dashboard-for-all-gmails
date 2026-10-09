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
from email.utils import getaddresses
from pathlib import Path
from typing import Annotated
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

import jinja2
from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import config, db
from app.ai import drafts
from app.ai import rules as sort_rules
from app.ai.scoring import QUADRANTS, quadrant
from app.send import message as mail
from app.send import outbox
from app.web import auth

log = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE / "static"

PAGE_SIZE = 50  # emails per page in a list (inbox tab, All mail), like Gmail
COLUMN_LIMIT = 100  # emails per matrix column
GROUPS = tuple(QUADRANTS)  # do, schedule, quick, later
ACTIONS = {"do": "Do now", "schedule": "Schedule", "quick": "Quick reply", "later": "Later"}
VIEWS = ("inbox", "all", "matrix")  # inbox: one tab per quadrant, like Gmail's Primary/Social/...
TABS = (*GROUPS, "unsorted")
COMPOSE_TITLES = {"new": "New message", "reply": "Reply", "all": "Reply all", "forward": "Forward"}
AVATAR_COLORS = ("#b3261e", "#8e3a9d", "#3949ab", "#00796b", "#2e7d32", "#c2410c", "#5d4037",
                 "#455a64", "#ad1457", "#1565c0")
MOVES = {"do": (5, 5), "schedule": (5, 2), "quick": (2, 5), "later": (2, 2)}
RULE_KINDS = {
    "vip": "Always important (VIP)",
    "low": "Always low priority",
    "private": "Private — never send to AI",
}
SCORED_BY = {"rule": "a rule", "gemma": "Gemma", "user": "you"}
SEARCH_FIELDS = ("subject", "from_email", "from_name", "snippet", "body_text")
ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver", *config.ALLOWED_HOSTS]
FLASH_COOKIE = "flash"
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")

COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}")
CATEGORY_RE = re.compile(r"[a-z0-9][a-z0-9 _-]{0,29}")
PATTERN_RE = re.compile(r"[^@\s]*@[^@\s]+\.[^@\s]+")

CARD_COLUMNS = """SELECT m.id, m.message_id, m.from_name, m.from_email, m.subject, m.snippet,
    m.received_at, m.is_read, m.has_attachments, m.answered_at, m.importance, m.urgency, m.category,
    m.action_needed, m.deadline, m.summary, m.reason, m.priority_score, m.scored_by,
    a.label AS account_label, a.email AS account_email, a.color AS account_color"""
FROM = " FROM messages m JOIN accounts a ON a.id = m.account_id"
# answered mail sinks below what still waits for you; otherwise highest priority first
ORDER = (" ORDER BY m.answered_at IS NOT NULL, m.priority_score IS NULL, m.priority_score DESC,"
         " m.received_at DESC, m.id DESC")

FormStr = Annotated[str | None, Form()]
NextField = Annotated[str | None, Form(alias="next")]


@dataclass
class Filters:
    """What the inbox page shows; kept in the query string across views."""

    view: str = "inbox"
    tab: str = "do"
    account: str = ""
    q: str = ""
    unread: bool = False
    category: str = ""
    unsorted: bool = False  # ?sorted=no: only mail the AI has not sorted yet
    # ?after=N / ?before=N: the 50 emails listed after / before email N. Anchored to an email,
    # not a position, so reading or moving mail on one page never makes the next page skip any.
    after: int | None = None
    before: int | None = None

    @classmethod
    def from_query(cls, params) -> "Filters":
        view = params.get("view", "")
        view = "all" if view == "list" else view if view in VIEWS else "inbox"
        tab = params.get("tab", "")
        return cls(
            view=view, tab=tab if tab in TABS else "do",
            account=params.get("account", "").strip(),
            q=params.get("q", "").strip()[:200],
            unread=params.get("unread", "") in ("1", "on", "true"),
            category=params.get("category", "").strip(),
            unsorted=params.get("sorted", "") == "no",
            after=_int(params.get("after")),
            before=None if _int(params.get("after")) else _int(params.get("before")),
        )

    @property
    def active(self) -> bool:
        return bool(self.account or self.q or self.unread or self.category or self.unsorted)

    def url(self, **changes) -> str:
        """Inbox URL with these filters, overridden by `changes`; empty values are dropped.
        Changing a filter, tab or view starts again at the top; opening an email keeps the page."""
        keep = set(changes) <= {"open"}
        after = changes.pop("after", self.after if keep else None)
        before = changes.pop("before", self.before if keep else None)
        params = {"view": self.view, "tab": self.tab, "account": self.account, "q": self.q,
                  "unread": "1" if self.unread else "", "category": self.category,
                  "sorted": "no" if self.unsorted else "", **changes,
                  "after": after or "", "before": "" if after else (before or "")}
        if params["view"] != "inbox" or params["tab"] == "do":
            params["tab"] = ""
        if params["view"] == "inbox":
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

def _avatar(name: str | None, email: str | None) -> dict:
    """Gmail-style round initial; the colour is fixed per sender."""
    key = (email or name or "?").strip().lower()
    letter = next((ch for ch in (name or email or "?") if ch.isalnum()), "?").upper()
    return {"letter": letter, "color": AVATAR_COLORS[sum(map(ord, key)) % len(AVATAR_COLORS)]}


def _card(row) -> dict:
    """A message row plus everything the templates need to show it."""
    m = dict(row)
    m["quad"] = quadrant(m["importance"], m["urgency"])
    m["sender"] = m["from_name"] or m["from_email"] or "(unknown sender)"
    m["avatar"] = _avatar(m["from_name"], m["from_email"])
    m["color"] = _color(m.get("account_color"))
    m["when"], m["when_full"] = _when(m["received_at"])
    m["due"] = _due(m["deadline"])
    m["scored_by_label"] = SCORED_BY.get(m["scored_by"] or "", m["scored_by"])
    return m


def _fetch(conn, where: str, args: list, extra: str = "", extra_args: list = (),
           limit: int = PAGE_SIZE, order: str = ORDER) -> list[dict]:
    sql = CARD_COLUMNS + FROM + _and(where, extra)
    rows = conn.execute(sql + order + " LIMIT ?", [*args, *extra_args, limit]).fetchall()
    return [_card(r) for r in rows]


def _and(where: str, extra: str) -> str:
    if not extra:
        return where
    return where + (" AND " if where else " WHERE ") + "(" + extra + ")"


# ORDER as a key (answered last, unsorted last, then priority, newest, id); "after" a key means
# further down the list. Priority and date sort descending, so their comparisons flip.
_KEY_COLS = "m.answered_at IS NOT NULL, m.priority_score IS NULL, COALESCE(m.priority_score, 0), m.received_at, m.id"
_AFTER = ("(k1 > ? OR (k1 = ? AND (k2 > ? OR (k2 = ? AND (k3 < ? OR (k3 = ? AND (k4 < ? OR (k4 = ? AND k5 < ?))))))))")
_REVERSED = (" ORDER BY m.answered_at IS NOT NULL DESC, m.priority_score IS NULL DESC, m.priority_score ASC,"
             " m.received_at ASC, m.id ASC")


def _beyond(key: tuple, direction: str) -> tuple[str, list]:
    """SQL for rows after (or before) the row with this sort key."""
    cols = ["(m.answered_at IS NOT NULL)", "(m.priority_score IS NULL)", "COALESCE(m.priority_score, 0)",
            "m.received_at", "m.id"]
    sql = _AFTER
    if direction == "before":
        sql = sql.replace(">", "#").replace("<", ">").replace("#", "<")
    for i, col in enumerate(cols, 1):
        sql = sql.replace(f"k{i}", col)
    k1, k2, k3, k4, k5 = key
    return sql, [k1, k1, k2, k2, k3, k3, k4, k4, k5]


def _page_of(conn, f: "Filters", where: str, args: list, extra: str, extra_args: list, total: int):
    """The 50 cards to show and Gmail's "51–100 of 312" pager for them. A cursor whose email is
    gone, or that points past either end, shows the first page."""
    anchor = f.after or f.before
    key = conn.execute(f"SELECT {_KEY_COLS} FROM messages m WHERE m.id = ?", (anchor,)).fetchone() if anchor else None
    cards = []
    if key is not None:
        cond, cargs = _beyond(tuple(key), "after" if f.after else "before")
        if f.after:
            cards = _fetch(conn, where, args, _and_extra(extra, cond), [*extra_args, *cargs])
        else:
            cards = _fetch(conn, where, args, _and_extra(extra, cond), [*extra_args, *cargs], order=_REVERSED)[::-1]
            if len(cards) < PAGE_SIZE:  # close to the top: that's just the first page
                cards = []
    first = 1
    if cards:
        head = conn.execute(f"SELECT {_KEY_COLS} FROM messages m WHERE m.id = ?", (cards[0]["id"],)).fetchone()
        cond, cargs = _beyond(tuple(head), "before")
        first = 1 + conn.execute("SELECT COUNT(*)" + FROM + _and(where, _and_extra(extra, cond)),
                                 [*args, *extra_args, *cargs]).fetchone()[0]
    else:
        cards = _fetch(conn, where, args, extra, extra_args)
    last = first + len(cards) - 1
    newer = None
    if cards and first > 1:
        newer = f.url(before=cards[0]["id"]) if first - 1 > PAGE_SIZE else f.url(after=None, before=None)
    return cards, {"first": first if cards else 0, "last": last if cards else 0, "total": total,
                   "pages": 2 if total > PAGE_SIZE else 1, "newer": newer,
                   "older": f.url(after=cards[-1]["id"]) if cards and last < total else None}


def _and_extra(extra: str, cond: str) -> str:
    return f"({extra}) AND {cond}" if extra else cond


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


def _tabs(conn, f: Filters) -> tuple[list[dict], list[dict], int]:
    """Inbox tabs (one per quadrant, plus "Not sorted" while the AI works) and the open tab's mail."""
    where, args = f.where()
    stats, pairs = _counts(conn, where, args)
    tabs = [{"key": k, "title": ACTIONS[k], "total": stats["quadrants"][k],
             "unread": stats["quadrant_unread"][k]} for k in GROUPS]
    if stats["unscored"] or f.tab == "unsorted":
        tabs.append({"key": "unsorted", "title": "Not sorted", "total": stats["unscored"],
                     "unread": None})
    if f.tab == "unsorted":
        total = stats["unscored"]
        cards, pager = _page_of(conn, f, where, args, "m.importance IS NULL OR m.urgency IS NULL", [], total)
    else:
        found = sorted(pairs[f.tab])
        cond = " OR ".join("(m.importance = ? AND m.urgency = ?)" for _ in found)
        total = stats["quadrants"][f.tab]
        cards, pager = (_page_of(conn, f, where, args, cond, [v for p in found for v in p], total) if found
                        else ([], {"first": 0, "last": 0, "total": 0, "pages": 1, "newer": None, "older": None}))
    return tabs, cards, total, pager


def _sender_suggestions(conn, f: "Filters") -> list[dict]:
    """Senders with several unsorted emails (all of them, not just this page): sort them in one go.
    Senders that already have a rule aren't offered again (a second tap would contradict it)."""
    where, args = f.where()
    rows = conn.execute(
        "SELECT lower(m.from_email) AS email, MAX(m.from_name) AS name, COUNT(*) AS n" + FROM
        + _and(where, "(m.importance IS NULL OR m.urgency IS NULL) AND m.from_email != ''")
        + " GROUP BY lower(m.from_email) HAVING COUNT(*) > 1 ORDER BY n DESC, email LIMIT 30", args).fetchall()
    rules = db.list_rules(conn)
    ruled = lambda email: any(sort_rules.matching_rule({"from_email": email}, rules, k) for k in RULE_KINDS)  # noqa: E731
    return [{"email": r["email"], "name": r["name"] or r["email"], "n": r["n"]}
            for r in rows if not ruled(r["email"])][:5]


def _sort_waiting(conn, kind: str, pattern: str) -> tuple[int, int]:
    """A new rule sorts that sender's waiting mail straight away, as the next sync would.
    VIP mail still goes to the AI, which reads every VIP email.
    Returns (sorted now, still waiting for the next sync)."""
    new, rules, done, left = [{"kind": kind, "pattern": pattern}], db.list_rules(conn), 0, 0
    for row in conn.execute("SELECT * FROM messages WHERE scored_by IS NULL").fetchall():
        if sort_rules.matching_rule(row, new, kind) is None:
            continue
        scores = sort_rules.decide(row, rules)
        if scores is None:
            left += 1
        else:
            db.save_scores(conn, row["id"], scores, "rule")
            done += 1
    return done, left


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
    synced = [a["last_synced_at"] for a in accounts if a["last_synced_at"]]
    return {
        "f": f, "accounts": accounts, "chips": chips, "stats": _counts(conn)[0],
        "categories": _categories(conn, f), "ai_calls": db.ai_calls_today(conn, _utc_day()),
        "ai_max": config.MAX_AI_CALLS_PER_DAY, "send_failures": outbox.failed(conn),
        "last_sync": _ago(max(synced)) if synced else None,
        "problems": [a for a in accounts if a["last_error"]],
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
        if ip.version == 6 and ip.ipv4_mapped:  # "::ffff:1.2.3.4" is just an IPv4 client
            return str(ip.ipv4_mapped)
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
               password_hash: str | None = None, totp_secret: str | None = None,
               accounts_loader: Callable[[], list] | None = None) -> FastAPI:
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
    static_v = _static_version()
    env.globals.update(QUADRANTS=QUADRANTS, ACTIONS=ACTIONS, RULE_KINDS=RULE_KINDS,
                       static_v=static_v, login_on=login_on, totp_on=bool(totp_secret))
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
        if request.method == "POST" and path == "/login":
            # the only body a stranger can send: refuse anything bigger than a login form
            # before it is parsed (a form may otherwise hold ~1 GB of fields)
            size = request.headers.get("content-length", "")
            if not size.isdigit() or int(size) > 16 * 1024:
                return PlainTextResponse("Request too large", status_code=413)
        if login_on and path not in ("/login", "/logout") and not path.startswith("/static/"):
            with connect() as conn:
                signed_in = auth.session_valid(conn, request.cookies.get(auth.COOKIE))
            if not signed_in:
                if not _wants_json(request) and "partial" not in request.query_params:
                    if request.method in ("GET", "HEAD"):
                        target = path + (f"?{request.url.query}" if request.url.query else "")
                    else:  # a plain form (no JavaScript): back to the page it was on, nothing re-sent
                        ref = urlsplit(request.headers.get("referer", ""))
                        same = ref.netloc == request.headers.get("host")
                        target = _safe_next((ref.path + (f"?{ref.query}" if ref.query else "")) if same else None)
                    return RedirectResponse("/login?" + urlencode({"next": target}), status_code=303)
                return JSONResponse({"ok": False, "message": "Please sign in again", "login": "/login"},
                                    status_code=401)
        resp = await call_next(request)
        if not path.startswith("/static/"):
            # nothing with email in it is kept by the browser (back button on a shared computer)
            resp.headers.setdefault("Cache-Control", "no-store")
        elif request.query_params.get("v") == static_v and resp.status_code in (200, 304):
            # ?v= changes with every file change, so a phone never has to ask again
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            resp.headers["Cache-Control"] = "no-cache"
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        # same-origin, not no-referrer: under no-referrer browsers send `Origin: null` with
        # plain form posts, which the guard above has to reject (that broke every no-JS form)
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        return resp

    # pages are mostly repeated markup: compressed they're ~20x smaller over Tailscale / mobile data
    # (outermost middleware, so every response is compressed, including the guard's)
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        if "text/html" in request.headers.get("accept", ""):
            return templates.TemplateResponse(
                request, "error.html", {"status": exc.status_code, "detail": exc.detail},
                status_code=exc.status_code)
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def bad_input(request: Request, exc: RequestValidationError):
        # a mangled link (/message/abc) gets the friendly page too; scripts still get the details
        if "text/html" in request.headers.get("accept", ""):
            return await http_error(request, StarletteHTTPException(404, "Not Found"))
        return await request_validation_exception_handler(request, exc)

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
        what = "password or code" if totp_secret else "password"
        failed = (f"That {what} isn't right. (After repeated wrong tries, sign-in pauses for "
                  f"up to {auth.FAIL_WINDOW_MIN} minutes.)")
        # never park a web thread on the lock: a flood would starve the signed-in pages
        if not login_lock.acquire(blocking=False):
            return login_page(request, nxt, "Busy, please try again in a moment.", 503)
        try:
            with connect() as conn:
                wait = auth.locked_minutes(conn, client)
                if wait:
                    return login_page(request, nxt, f"Too many wrong attempts. Try again in {wait} "
                                                    f"minute{'s' if wait != 1 else ''}.", 429)
                if auth.locked_minutes(conn, auth.CODE_GUARD, auth.MAX_CODE_FAILURES):
                    # paused because someone had the password: answer exactly like a wrong
                    # password, so the pause doesn't tell a guesser their password was right
                    auth.record_failure(conn, client)
                    conn.commit()
                    return login_page(request, nxt, failed, 401)
                ok_pw = auth.verify_password((password or "")[:1024], password_hash)
                counter = None
                if totp_secret:
                    counter = auth.check_totp(totp_secret, (code or "")[:32], auth.last_totp_counter(conn))
                if not ok_pw or (totp_secret and counter is None):
                    auth.record_failure(conn, client)
                    if ok_pw:  # someone has the password but not the phone: pause logins for everyone
                        auth.record_failure(conn, auth.CODE_GUARD)
                        log.error("correct password but wrong 2-step code from %s: change the "
                                  "password (python -m app.cli set-login)", client)
                    conn.commit()
                    log.warning("failed login from %s", client)
                    return login_page(request, nxt, failed, 401)
                auth.clear_failures(conn, client)
                if counter is not None:
                    auth.save_totp_counter(conn, counter)
                token, _ = auth.create_session(conn, bool(remember),
                                               request.headers.get("user-agent", ""))
                conn.commit()
        finally:
            login_lock.release()
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
        # unsent drafts saved in this browser go when the login page loads (prefs.js); Settings stay
        return resp

    @app.get("/")
    def index(request: Request):
        f = Filters.from_query(request.query_params)
        open_id = _int(request.query_params.get("open"))
        with connect() as conn:
            ctx = _page(request, conn, f, page=f.view, open_id=open_id, msg=None)
            if f.view == "all":
                where, args = f.where()
                ctx["total"] = conn.execute("SELECT COUNT(*)" + FROM + where, args).fetchone()[0]
                ctx["cards"], ctx["pager"] = _page_of(conn, f, where, args, "", [], ctx["total"])
                ctx["unsorted"] = {"total": 0}
            elif f.view == "matrix":
                ctx["columns"], ctx["unsorted"], ctx["total"] = _matrix(conn, f)
            else:
                ctx["tabs"], ctx["cards"], ctx["total"], ctx["pager"] = _tabs(conn, f)
                if f.tab == "unsorted":
                    ctx["senders"] = _sender_suggestions(conn, f)
                ctx["unsorted"] = {"total": ctx["stats"]["unscored"] if not f.active else
                                   next((t["total"] for t in ctx["tabs"] if t["key"] == "unsorted"), 0)}
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
            sorted_now, left = _sort_waiting(conn, kind, p)
            conn.commit()
        if sorted_now:
            done = f"Sorted {sorted_now} waiting email{'s' if sorted_now != 1 else ''}."
        elif left:
            done = f"{left} waiting email{'s are' if left != 1 else ' is'} sorted at the next sync."
        else:
            done = "It applies to their new mail from now on."
        return _reply(request, f"Rule saved: {RULE_KINDS[kind]} for {p}. {done}",
                      next_url, kind=kind, pattern=p, sorted=sorted_now)

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

    # --- writing mail ---------------------------------------------------------------------
    def load_accounts() -> list[config.Account]:
        try:
            return list((accounts_loader or (lambda: config.load_accounts(config.ACCOUNTS_FILE)))())
        except SystemExit:  # no accounts.yaml
            return []
        except Exception as exc:  # noqa: BLE001 - a typo in accounts.yaml
            log.error("accounts.yaml can't be read: %s", exc)
            return []

    def compose_ctx(conn, *, mode: str = "new", reply_id: int | None = None, from_email: str = "",
                    draft=None, values: dict | None = None, error: str = "", nxt: str = "/",
                    variant: str = "page") -> dict:
        accounts = load_accounts()
        if draft is not None:
            mode, reply_id, from_email = draft["mode"], draft["reply_to_id"], draft["account_email"]
        mode = mode if mode in mail.MODES else "new"
        original = db.get_message(conn, reply_id) if reply_id and mode != "new" else None
        if mode != "new" and original is None:
            mode, error = "new", error or "The email you were answering is no longer here."
        v = {"to": "", "cc": "", "bcc": "", "subject": "", "body": "", "include_quote": True,
             "instruction": ""}
        if original is not None:
            from_email = from_email or original["account_email"]
            if mode == "forward":
                v["subject"] = mail.forward_subject(original["subject"])
            else:
                to, cc = mail.reply_recipients(original, mode, {a.email.lower() for a in accounts})
                v.update(to=mail.format_addresses(to), cc=mail.format_addresses(cc),
                         subject=mail.reply_subject(original["subject"]))
        if draft is not None:
            v.update(to=draft["to_addrs"], cc=draft["cc_addrs"], bcc=draft["bcc_addrs"],
                     subject=draft["subject"], body=draft["body"],
                     include_quote=bool(draft["include_quote"]))
        v.update({k: val for k, val in (values or {}).items() if val is not None})
        emails = [a.email for a in accounts]
        if from_email.lower() not in (e.lower() for e in emails):
            from_email = emails[0] if emails else ""
        quote = None
        if original is not None:
            quote = mail.forward_block(original) if mode == "forward" else mail.quote_reply(original)
        return {
            "mode": mode, "title": COMPOSE_TITLES[mode], "original": _card(original) if original else None,
            "v": v, "quote": quote, "send_accounts": accounts, "from_email": from_email,
            "draft_id": draft["id"] if draft is not None else None, "compose_error": error,
            "compose_next": nxt, "variant": variant, "undo_seconds": outbox.UNDO_SECONDS,
            # an undone email keeps edits made since under its own key, not as a new message
            "draft_key": f"draft:outbox:{draft['id']}" if draft is not None else f"draft:{mode}:" + ((original["message_id"] or str(original["id"]))
                                             if original is not None else "new"),
        }

    def compose_page(request: Request, conn, cctx: dict, status: int = 200):
        ctx = _page(request, conn, Filters(), page="compose", **cctx)
        return render(request, "compose.html", ctx, status)

    def compose_values(form: dict) -> dict:
        return {"to": form.get("to") or "", "cc": form.get("cc") or "", "bcc": form.get("bcc") or "",
                "subject": form.get("subject") or "", "body": form.get("body") or "",
                "include_quote": form.get("include_quote") not in (None, "", "0"),
                "instruction": form.get("instruction") or ""}

    @app.get("/compose")
    def compose(request: Request, mode: str = "new", reply: str = "", draft: str = "",
                partial: str = "", from_email: Annotated[str, Query(alias="from")] = "",
                next_url: Annotated[str, Query(alias="next")] = ""):
        nxt = _safe_next(next_url)
        with connect() as conn:
            draft_row = outbox.get(conn, _int(draft)) if _int(draft) else None
            if draft_row is not None and draft_row["status"] not in ("cancelled", "failed"):
                draft_row = None  # only an undone or failed email can be edited again
            cctx = compose_ctx(conn, mode=mode, reply_id=_int(reply), from_email=from_email,
                               draft=draft_row, nxt=nxt,
                               variant=partial if partial in ("inline", "window") else "page")
            if partial:
                return templates.TemplateResponse(request, "_compose.html", cctx)
            return compose_page(request, conn, cctx)

    async def read_form(request: Request) -> dict:
        form = await request.form()
        return {k: (v if isinstance(v, str) else None) for k, v in form.items()}

    @app.post("/compose/send")
    async def compose_send(request: Request):
        form = await read_form(request)
        return await run_in_threadpool(send_mail, request, form)

    def send_mail(request: Request, form: dict):
        nxt = _safe_next(form.get("next"))
        mode = form.get("mode") if form.get("mode") in mail.MODES else "new"
        reply_id = _int(form.get("reply_id"))
        values = compose_values(form)
        account = outbox.account_for(form.get("from_account") or "", load_accounts())

        def fail(message: str, field: str | None = None):
            if _wants_json(request):
                return JSONResponse({"ok": False, "message": message, "field": field}, status_code=400)
            with connect() as conn:
                cctx = compose_ctx(conn, mode=mode, reply_id=reply_id,
                                   from_email=form.get("from_account") or "", values=values,
                                   error=message, nxt=nxt)
                return compose_page(request, conn, cctx, 400)

        if account is None:
            return fail("Pick the account to send from.", "from_account")
        groups = {}
        for field in ("to", "cc", "bcc"):
            try:
                groups[field] = mail.parse_addresses(values[field])
            except mail.AddressError as exc:
                return fail(f"{field.capitalize()}: {exc}.", field)
        if not any(groups.values()):
            return fail("Add at least one recipient.", "to")
        if sum(map(len, groups.values())) > mail.MAX_RECIPIENTS:
            return fail(f"At most {mail.MAX_RECIPIENTS} recipients per email.", "to")
        if len(values["body"]) > mail.MAX_BODY_CHARS:
            return fail("The message is too long.", "body")
        try:
            mail.build(account, groups["to"], groups["cc"], groups["bcc"], values["subject"], "")
        except ValueError as exc:
            return fail(f"This email can't be sent as it is: {exc}")
        with connect() as conn:
            original = db.get_message(conn, reply_id) if reply_id and mode != "new" else None
            if mode != "new" and original is None:
                return fail("The email you were answering is no longer here.")
            in_reply_to, references = (mail.thread_headers(original) if mode in ("reply", "all")
                                       else (None, None))
            oid = outbox.queue(
                conn, account_email=account.email, mode=mode,
                reply_to_id=original["id"] if original is not None else None,
                to=mail.format_addresses(groups["to"]), cc=mail.format_addresses(groups["cc"]),
                bcc=mail.format_addresses(groups["bcc"]), subject=mail.clean_subject(values["subject"]),
                body=values["body"], include_quote=values["include_quote"],
                full_text=mail.full_text(values["body"], mode, original, values["include_quote"]),
                in_reply_to=in_reply_to, references=references)
            if _int(form.get("draft_id")):
                outbox.discard(conn, _int(form.get("draft_id")))
            conn.commit()
        return _reply(request, f"Sending in {outbox.UNDO_SECONDS} seconds… (Undo is here on Sent)"
                      if not _wants_json(request) else f"Sending in {outbox.UNDO_SECONDS} seconds…",
                      nxt if _wants_json(request) else "/sent", id=oid,
                      undo_seconds=outbox.UNDO_SECONDS, next=nxt)

    @app.post("/compose/draft")
    async def compose_draft(request: Request):
        form = await read_form(request)
        return await run_in_threadpool(ai_draft, request, form)

    def ai_draft(request: Request, form: dict):
        nxt = _safe_next(form.get("next"))
        mode = form.get("mode") if form.get("mode") in mail.MODES else "new"
        reply_id = _int(form.get("reply_id"))
        values = compose_values(form)
        account = outbox.account_for(form.get("from_account") or "", load_accounts())
        with connect() as conn:
            original = db.get_message(conn, reply_id) if reply_id and mode != "new" else None
            try:
                text = drafts.write(conn, mode=mode, original=original,
                                    instruction=values["instruction"],
                                    from_name=account.from_name if account else "")
            except drafts.DraftError as exc:
                if _wants_json(request):
                    return JSONResponse({"ok": False, "message": str(exc)}, status_code=422)
                cctx = compose_ctx(conn, mode=mode, reply_id=reply_id,
                                   from_email=form.get("from_account") or "", values=values,
                                   error=str(exc), nxt=nxt)
                return compose_page(request, conn, cctx, 422)
            if _wants_json(request):
                return JSONResponse({"ok": True, "message": "Draft ready", "text": text})
            values["body"] = text
            cctx = compose_ctx(conn, mode=mode, reply_id=reply_id,
                               from_email=form.get("from_account") or "", values=values, nxt=nxt)
            return compose_page(request, conn, cctx)

    @app.post("/outbox/{outbox_id}/undo")
    def undo_send(request: Request, outbox_id: int):
        with connect() as conn:
            stopped = outbox.cancel(conn, outbox_id)
            conn.commit()
            row = outbox.get(conn, outbox_id)
        if row is None:
            raise HTTPException(404, "That email isn't in the outbox")
        if not stopped and row["status"] != "cancelled":  # undoing twice is still just undone
            return _reply(request, "Too late to undo: it has already gone out." if row["status"] in
                          ("sending", "sent") else "It wasn't waiting to be sent.", "/sent",
                          ok=False, status=409, status_text=row["status"])
        edit = f"/compose?draft={outbox_id}"
        return _reply(request, "Sending undone", edit, edit_url=edit)

    @app.post("/outbox/{outbox_id}/discard")
    def discard_send(request: Request, outbox_id: int, next_url: NextField = None):
        with connect() as conn:
            gone = outbox.discard(conn, outbox_id)
            conn.commit()
        return _reply(request, "Discarded" if gone else "Nothing to discard", next_url or "/sent",
                      ok=gone, status=None if gone else 409)

    @app.get("/api/outbox/{outbox_id}")
    def outbox_status(outbox_id: int):
        with connect() as conn:
            row = outbox.get(conn, outbox_id)
        if row is None:
            raise HTTPException(404, "That email isn't in the outbox")
        return {"id": row["id"], "status": row["status"], "error": row["error"], "note": row["note"],
                "subject": row["subject"]}

    @app.get("/sent")
    def sent_page(request: Request):
        with connect() as conn:
            rows = []
            for r in outbox.history(conn):
                item = dict(r)
                item["when"], item["when_full"] = _when(r["sent_at"] or r["created_at"])
                fields = [v for v in (r["to_addrs"], r["cc_addrs"], r["bcc_addrs"]) if v]
                item["who"] = ", ".join(n or a for n, a in getaddresses(fields) if a)[:200]
                rows.append(item)
            ctx = _page(request, conn, Filters(), page="sent", sent=rows)
        return render(request, "sent.html", ctx)

    @app.get("/api/stats")
    def api_stats():
        with connect() as conn:
            stats = _counts(conn)[0]
            stats.update(ai_calls_today=db.ai_calls_today(conn, _utc_day()),
                         ai_calls_max=config.MAX_AI_CALLS_PER_DAY)
        return stats

    return app
