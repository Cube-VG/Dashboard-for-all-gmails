"""Cheap pre-filter: score obvious mail from sender rules and patterns, with no API call.

decide() returns a scores dict when a rule settles the email, or None to send it to the AI.
"""

import re
from datetime import datetime, timedelta, timezone

AI_MAX_AGE_DAYS = 7  # older mail is scored by rules only
OTP_FRESH_HOURS = 24  # after that a code is no longer urgent

_OTP_WORDS = (
    r"(?:otp|passcode|one[- ]time (?:pass(?:word|code)?|code|pin)"
    r"|(?:verification|security|confirmation|authentication|sign[- ]?in|log[- ]?in|access)"
    r" (?:code|pin))"
)
OTP_SUBJECT_RE = re.compile(rf"\b{_OTP_WORDS}\b", re.I)
# in the body, only when an actual code follows ("Never share your OTP" footers don't count)
OTP_SNIPPET_RE = re.compile(
    rf"\b{_OTP_WORDS}\b[^.\d]{{0,40}}?\b\d{{4,8}}\b|\b\d{{4,8}} is your\b", re.I)
BULK_LOCAL_RE = re.compile(
    r"^(newsletters?|news|digest|marketing|promos?|promotions?|offers|deals|mailer|campaigns?)"
    r"([._+-]|\d|$)",
    re.I,
)
NOREPLY_RE = re.compile(r"^(no-?reply|do-?not-?reply)([._+-]|\d|$)", re.I)
PROMO_WORDS_RE = re.compile(
    r"(\b\d+ ?% off\b|\b(sale|deals?|discount|coupons?|promo code|limited time|free shipping"
    r"|newsletter|webinar|black friday|cyber monday|last chance|shop now|unsubscribe)\b)",
    re.I,
)


def _get(msg, key: str):
    try:
        return msg[key]
    except (KeyError, IndexError):  # sqlite3.Row raises IndexError
        return None


def _addr(msg) -> str:
    return (_get(msg, "from_email") or "").strip().lower()


def _matches(addr: str, pattern: str) -> bool:
    pattern = (pattern or "").strip().lower()
    if not addr or not pattern:
        return False
    if "@" not in pattern:  # bare "domain.com" means "@domain.com"
        pattern = "@" + pattern
    return addr.endswith(pattern) if pattern.startswith("@") else addr == pattern


def matching_rule(msg, rules, kind: str) -> str | None:
    """The first pattern of this kind that matches the sender, if any."""
    addr = _addr(msg)
    for r in rules:
        if r["kind"] == kind and _matches(addr, r["pattern"]):
            return r["pattern"]
    return None


def is_vip(msg, rules) -> bool:
    return matching_rule(msg, rules, "vip") is not None


def apply_vip(scores: dict) -> dict:
    """VIP mail is always important, whatever the AI said."""
    reason = scores.get("reason")
    return {**scores, "importance": 5,
            "reason": f"VIP sender. {reason}" if reason else "VIP sender"}


def is_otp(msg) -> bool:
    return bool(OTP_SUBJECT_RE.search(_get(msg, "subject") or "")
                or OTP_SNIPPET_RE.search(_get(msg, "snippet") or ""))


def _received(msg) -> datetime | None:
    try:
        d = datetime.fromisoformat(_get(msg, "received_at"))
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _scores(importance: int, urgency: int, category: str, reason: str) -> dict:
    return {"importance": importance, "urgency": urgency, "category": category,
            "action_needed": False, "deadline": None, "summary": None, "reason": reason}


def _bulk_category(msg) -> str:
    return "promo" if PROMO_WORDS_RE.search(_get(msg, "subject") or "") else "newsletter"


def decide(msg, rules, now: datetime | None = None) -> dict | None:
    """Scores for mail the rules can settle, or None to send it to the AI.

    msg is a messages row or dict; rules is db.list_rules() (rows/dicts with kind and pattern).
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    received = _received(msg)
    age = now - received if received else timedelta(0)
    local = _addr(msg).split("@")[0]
    vip = is_vip(msg, rules)

    if matching_rule(msg, rules, "private") is not None:
        if vip:
            return _scores(5, 3, "private", "VIP private sender — not sent to AI")
        return _scores(3, 3, "private", "Private sender — not sent to AI")
    if vip:
        return None  # the AI always reads VIP mail; apply_vip() boosts its answer

    if (p := matching_rule(msg, rules, "low")) is not None:
        return _scores(1, 1, _bulk_category(msg), f"Low-priority sender rule ({p})")
    if is_otp(msg):
        if age > timedelta(hours=OTP_FRESH_HOURS):
            return _scores(2, 1, "otp", "One-time / verification code (expired by now)")
        return _scores(2, 5, "otp", "One-time / verification code — use it now")
    if _get(msg, "list_unsubscribe"):
        return _scores(1, 1, _bulk_category(msg), "Bulk mail (has a List-Unsubscribe header)")
    if BULK_LOCAL_RE.match(local):
        return _scores(1, 1, _bulk_category(msg), f"Bulk sender address ({local}@)")
    if NOREPLY_RE.match(local) and PROMO_WORDS_RE.search(
            f"{_get(msg, 'subject') or ''} {_get(msg, 'snippet') or ''}"):
        return _scores(1, 1, "promo", "No-reply sender with promotional wording")
    if age > timedelta(days=AI_MAX_AGE_DAYS):
        return _scores(2, 1, "other", f"Older than {AI_MAX_AGE_DAYS} days — scored by rules only")
    return None
