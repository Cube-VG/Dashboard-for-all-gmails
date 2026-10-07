"""Command line tools. The full app (dashboard + background sync) starts with `python -m app`.

    python -m app.cli set-password you@gmail.com   save an account's password in the OS keyring
    python -m app.cli check                         try logging in to every account
    python -m app.cli sync                          fetch new mail from every account
    python -m app.cli classify                      sort unscored mail (rules + Gemma)
    python -m app.cli run-once                      sync + sort + notify, once
    python -m app.cli list [--account EMAIL] [-n 30] show the newest saved mail
    python -m app.cli test-ai                       check your OpenRouter key + Gemma
    python -m app.cli prune [--days 14]             delete saved mail older than N days
"""

import argparse
import getpass
import logging

from app import config, db


def cmd_set_password(args):
    pw = getpass.getpass(f"Password / App Password for {args.email}: ").replace(" ", "")
    config.set_password(args.email, pw)
    print("Saved in your OS keyring.")


def cmd_check(args):
    from app.sync.imap_sync import connect_mailbox

    for a in config.load_accounts():
        pw = config.get_password(a.email)
        if not pw:
            print(f"✗ {a.label:<22} no password saved (python -m app.cli set-password {a.email})")
            continue
        try:
            with connect_mailbox(a.imap_host, a.imap_port).login(a.username, pw, initial_folder=a.folder):
                print(f"✓ {a.label:<22} {a.email}")
        except Exception as exc:  # noqa: BLE001
            print(f"✗ {a.label:<22} {a.email}: {exc}")


def cmd_sync(args):
    from app.sync.imap_sync import sync_all

    with db.connect() as conn:
        for email, result in sync_all(conn, config.load_accounts()).items():
            print(f"{email:<35} {result if isinstance(result, str) else f'{result} new'}")


def cmd_classify(args):
    from app.ai.classifier import classify_pending

    logging.getLogger().setLevel(logging.INFO)
    with db.connect() as conn:
        print(classify_pending(conn))


def cmd_run_once(args):
    from app.runner import run_cycle

    logging.getLogger().setLevel(logging.INFO)
    print(run_cycle())


def cmd_list(args):
    with db.connect() as conn:
        for m in db.recent_messages(conn, args.n, args.account):
            dot = " " if m["is_read"] else "●"
            sender = (m["from_name"] or m["from_email"])[:24]
            score = f"{m['priority_score']:.1f}" if m["priority_score"] is not None else "  - "
            print(f"{dot} {score}  {m['received_at'][:16]}  {m['account_label'][:14]:<14}  {sender:<24}  {m['subject'][:60]}")


def cmd_prune(args):
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days)).isoformat()
    with db.connect() as conn:
        removed = db.prune_old_messages(conn, cutoff)
        conn.commit()
        conn.execute("VACUUM")
        left = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    print(f"Removed {removed} emails older than {args.days} days; {left} left. "
          "Older mail is never downloaded again.")


def cmd_test_ai(args):
    from openai import OpenAI

    if not config.OPENROUTER_API_KEY:
        raise SystemExit("Set OPENROUTER_API_KEY in .env first.")
    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=config.OPENROUTER_API_KEY)
    for model in (config.AI_MODEL, config.AI_FALLBACK_MODEL):
        try:
            r = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "Reply with just the word: ready"}],
                max_tokens=10,
            )
            print(f"✓ {model}: {r.choices[0].message.content.strip()}")
        except Exception as exc:  # noqa: BLE001
            print(f"✗ {model}: {exc}")


def main():
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    p = argparse.ArgumentParser(prog="python -m app.cli")
    sub = p.add_subparsers(required=True)

    s = sub.add_parser("set-password", help="save an account password in the OS keyring")
    s.add_argument("email")
    s.set_defaults(func=cmd_set_password)

    sub.add_parser("check", help="test login to every account").set_defaults(func=cmd_check)
    sub.add_parser("sync", help="fetch new mail").set_defaults(func=cmd_sync)
    sub.add_parser("classify", help="sort unscored mail").set_defaults(func=cmd_classify)
    sub.add_parser("run-once", help="sync + sort + notify once").set_defaults(func=cmd_run_once)

    s = sub.add_parser("list", help="show newest saved mail")
    s.add_argument("-n", type=int, default=30)
    s.add_argument("--account", help="only this email address")
    s.set_defaults(func=cmd_list)

    sub.add_parser("test-ai", help="check OpenRouter + Gemma").set_defaults(func=cmd_test_ai)

    s = sub.add_parser("prune", help="delete saved mail older than N days (stop the app first)")
    s.add_argument("--days", type=int, default=config.SYNC_DAYS_BACK)
    s.set_defaults(func=cmd_prune)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
