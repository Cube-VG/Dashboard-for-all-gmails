"""Turn importance/urgency into one sortable number and a matrix quadrant."""

from datetime import date, datetime, timezone

QUADRANTS = {
    "do": "Urgent + important",
    "schedule": "Important, not urgent",
    "quick": "Urgent, not important",
    "later": "Neither",
}


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def priority_score(importance, urgency, deadline=None, action_needed=False, is_read=False,
                   today: date | None = None) -> float | None:
    if importance is None or urgency is None:
        return None
    today = today or datetime.now(timezone.utc).date()
    score = importance * 0.6 + urgency * 0.4
    d = _parse_date(deadline)
    if d is not None and 0 <= (d - today).days <= 2:
        score += 1.0
    if action_needed:
        score += 0.5
    if is_read:
        score -= 0.5
    return round(score, 2)


def quadrant(importance, urgency) -> str | None:
    """Eisenhower bucket; 4 or 5 counts as 'high'."""
    if importance is None or urgency is None:
        return None
    important, urgent = importance >= 4, urgency >= 4
    if important and urgent:
        return "do"
    if important:
        return "schedule"
    if urgent:
        return "quick"
    return "later"
