"""Score unscored mail: rules first, then Gemma via OpenRouter, ~20 emails per request.

Free model first, paid model as fallback, and never more than MAX_AI_CALLS_PER_DAY requests.
"""

import json
import logging
import re
from datetime import date, datetime, timezone

import openai

from app import config, db
from app.ai import prompt, rules

log = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
TOKENS_PER_EMAIL = 150  # one JSON entry with a short summary and reason
TEXT_CHARS = 200


class BudgetReached(Exception):
    pass


def _is_outage(exc: Exception) -> bool:
    """Errors that will hit every batch (rate limit, bad key, no credits, no network)."""
    return (isinstance(exc, openai.APIConnectionError)
            or getattr(exc, "status_code", None) in (401, 402, 403, 429))


def make_client() -> openai.OpenAI | None:
    if not config.OPENROUTER_API_KEY:
        return None
    return openai.OpenAI(base_url=OPENROUTER_BASE_URL, api_key=config.OPENROUTER_API_KEY,
                         timeout=120, max_retries=1)


def _extract_json(text: str):
    text = re.sub(r"```(?:json)?", "", text or "", flags=re.I)
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in "{[":
            try:
                data = decoder.raw_decode(text, i)[0]
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict) or any(isinstance(x, dict) for x in data):
                return data
    raise ValueError("no JSON in the reply")


def _level(value) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return max(1, min(5, round(float(value))))
    except (TypeError, ValueError, OverflowError):
        return None


def _flag(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "y", "1")
    return bool(value)


def _deadline(value) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()[:10]).isoformat()
    except ValueError:
        return None


def _text(value) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()[:TEXT_CHARS]
    return text or None


def validate(item: dict) -> dict | None:
    """Clean one entry of the model's answer, or None if it has no usable scores."""
    importance, urgency = _level(item.get("importance")), _level(item.get("urgency"))
    if importance is None or urgency is None:
        return None
    category = str(item.get("category") or "").strip().lower()
    return {
        "importance": importance,
        "urgency": urgency,
        "category": category if category in prompt.CATEGORIES else "other",
        "action_needed": _flag(item.get("action_needed")),
        "deadline": _deadline(item.get("deadline")),
        "summary": _text(item.get("summary")),
        "reason": _text(item.get("reason")),
    }


def parse_reply(content: str, ids) -> dict[int, dict]:
    """{message id: scores} for the ids we asked about; anything else is ignored."""
    data = _extract_json(content)
    if isinstance(data, dict):
        data = data.get("emails", [data] if "id" in data else None)
    if not isinstance(data, list):
        raise ValueError("reply has no 'emails' list")
    wanted, results = set(ids), {}
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            msg_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        if msg_id in wanted and msg_id not in results and (scores := validate(item)):
            results[msg_id] = scores
    return results


def _ask(conn, client, models: list[str], messages, ids, day: str) -> dict[int, dict]:
    """Try the models in order (free, then paid) until one gives usable scores."""
    error: Exception | None = None
    for model in list(models):
        if db.ai_calls_today(conn, day) >= config.MAX_AI_CALLS_PER_DAY:
            raise BudgetReached
        db.count_ai_call(conn, day)
        conn.commit()
        try:
            resp = client.chat.completions.create(
                model=model, messages=messages, temperature=0,
                response_format={"type": "json_object"},
                max_tokens=TOKENS_PER_EMAIL * len(ids) + 200,
            )
            results = parse_reply(resp.choices[0].message.content, ids)
            if results:
                return results
            error = ValueError("reply had no usable scores")
        except openai.RateLimitError as exc:
            error = exc
            if len(models) > 1 and model == models[0]:
                models.remove(model)  # free quota used up: go straight to the paid model this run
        except Exception as exc:  # noqa: BLE001 - API error, odd response or bad JSON
            error = exc
        log.warning("%s failed: %s", model, error)
    raise error or RuntimeError("no AI model configured")


def classify_pending(conn, client=None, *, batch_size: int = 20, max_messages: int = 200,
                     now: datetime | None = None) -> dict[str, int]:
    """Score up to max_messages unscored emails. Returns how many were scored by rules, by the
    AI, failed (left unscored for next run) or skipped because of the daily budget / no API key."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)
    counts = {"rule_scored": 0, "ai_scored": 0, "failed": 0, "skipped_budget": 0}

    rule_rows = db.list_rules(conn)
    labels = {a["id"]: a["label"] for a in db.list_accounts(conn)}
    pending: list[dict] = []
    for row in db.unscored_messages(conn, max_messages):
        msg = dict(row)
        msg["account_label"] = labels.get(msg["account_id"])
        scores = rules.decide(msg, rule_rows, now)
        if scores is None:
            pending.append(msg)
        else:
            db.save_scores(conn, msg["id"], scores, "rule")
            counts["rule_scored"] += 1
    conn.commit()
    if not pending:
        return counts

    client = client or make_client()
    if client is None:
        log.warning("OPENROUTER_API_KEY is not set: %d emails wait for the AI", len(pending))
        counts["skipped_budget"] += len(pending)
        return counts

    day = now.date().isoformat()
    feedback = db.recent_feedback(conn, prompt.MAX_EXAMPLES)
    models = list(dict.fromkeys(m for m in (config.AI_MODEL, config.AI_FALLBACK_MODEL) if m))
    for start in range(0, len(pending), batch_size):
        batch = pending[start:start + batch_size]
        ids = [m["id"] for m in batch]
        left = len(pending) - start
        try:
            results = _ask(conn, client, models, prompt.build_messages(batch, now.date(), feedback),
                           ids, day)
            for msg in batch:
                if (scores := results.get(msg["id"])) is not None:
                    if rules.is_vip(msg, rule_rows):
                        scores = rules.apply_vip(scores)
                    db.save_scores(conn, msg["id"], scores, "gemma")
            conn.commit()
        except BudgetReached:
            counts["skipped_budget"] += left
            log.warning("Daily AI budget (%d calls) reached: %d emails wait for tomorrow",
                        config.MAX_AI_CALLS_PER_DAY, left)
            break
        except Exception as exc:  # noqa: BLE001 - one bad batch never stops the run
            conn.rollback()
            if _is_outage(exc):
                counts["failed"] += left
                log.error("AI unavailable (%s): %d emails wait for the next run", exc, left)
                break
            counts["failed"] += len(batch)
            log.error("AI batch of %d emails failed: %s", len(batch), exc)
            continue
        counts["ai_scored"] += len(results)
        counts["failed"] += len(batch) - len(results)  # missing ones stay unscored for next run

    log.info("classify: %s", counts)
    return counts
