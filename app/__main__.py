"""Start the whole app: dashboard + background sync + notifications.

    python -m app                  open the dashboard in your browser
    python -m app --window         open it in its own window (needs: pip install pywebview)
    python -m app --no-browser     just run in the background
    python -m app --no-scheduler   no automatic syncing (use "Sync now")
    python -m app --port 8001      use another port
"""

import argparse
import logging
import socket
import sys
import threading
import time
import webbrowser

import uvicorn

from app import config
from app.runner import is_running, run_cycle
from app.scheduler import SYNC_INTERVAL_MINUTES, start_scheduler

HOST = "127.0.0.1"  # this machine only: never reachable from the network

SETUP_HELP = f"""\
No {config.ACCOUNTS_FILE.name} yet, so the dashboard starts empty. To add your mailboxes:
  1. copy accounts.example.yaml to {config.ACCOUNTS_FILE.name} and list your accounts
  2. save each password once:  python -m app.cli set-password you@gmail.com
  3. press "Sync now" in the dashboard (or wait for the next automatic sync)
"""


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m app", description="Unified inbox dashboard")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    p.add_argument("--window", action="store_true", help="open in a desktop window (pywebview)")
    p.add_argument("--no-scheduler", action="store_true", help="don't sync in the background")
    return p.parse_args(argv)


def _fix_streams() -> None:
    """pythonw (no console) has no stdout/stderr, which breaks print and uvicorn's logging."""
    if sys.stdout is None or sys.stderr is None:
        path = config.DB_PATH.parent / "app.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - lives until exit
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream


def _port_in_use(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((HOST, port)) == 0


def _wait_until(condition, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.1)
    return True


def _load_webview():
    try:
        import webview
    except ImportError:
        print("The desktop window needs pywebview (pip install pywebview). Using your browser instead.")
        return None
    return webview


def _announce(url: str, scheduler_on: bool) -> None:
    print(f"\nInbox dashboard is running at {url}")
    if scheduler_on:
        print(f"Checking mail every {SYNC_INTERVAL_MINUTES:g} minutes. Press Ctrl+C to stop.\n")
    else:
        print("Background sync is off: use \"Sync now\". Press Ctrl+C to stop.\n")


def _run_in_browser(server: uvicorn.Server, url: str, open_browser: bool, scheduler_on: bool) -> None:
    def when_ready():
        if _wait_until(lambda: server.started, 30):
            _announce(url, scheduler_on)
            if open_browser:
                webbrowser.open(url)

    threading.Thread(target=when_ready, daemon=True).start()
    server.run()


def _run_in_window(server: uvicorn.Server, url: str, webview, scheduler_on: bool) -> None:
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    _wait_until(lambda: server.started or not thread.is_alive(), 30)
    if not server.started:
        print("The dashboard server did not start; see the messages above.")
        return
    _announce(url, scheduler_on)
    webview.create_window("Inbox", url, width=1280, height=860)
    webview.start()  # blocks until the window is closed
    server.should_exit = True
    thread.join(timeout=5)


def main(argv=None) -> int:
    args = parse_args(argv)
    _fix_streams()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    logging.getLogger("apscheduler").setLevel(logging.WARNING)

    url = f"http://{HOST}:{args.port}"
    if _port_in_use(args.port):
        print(f"Port {args.port} is already in use. Is the dashboard already open at {url}?\n"
              f"Otherwise start it on another port: python -m app --port {args.port + 1}")
        return 1
    if not config.ACCOUNTS_FILE.exists():
        print(SETUP_HELP)

    try:
        from app.web.main import create_app
    except ImportError as exc:
        print(f"Could not load the dashboard (app.web.main): {exc}")
        return 1
    web_app = create_app(on_sync_now=lambda: run_cycle())
    server = uvicorn.Server(uvicorn.Config(web_app, host=HOST, port=args.port, log_level="warning"))

    webview = _load_webview() if args.window else None
    scheduler = None if args.no_scheduler else start_scheduler()
    from app.send.outbox import start_worker
    stop_outbox = start_worker()  # sends what you write once its Undo time is over
    try:
        if webview:
            _run_in_window(server, url, webview, scheduler is not None)
        else:
            _run_in_browser(server, url, not args.no_browser, scheduler is not None)
    except KeyboardInterrupt:  # uvicorn re-raises Ctrl+C after its own clean shutdown
        pass
    finally:
        stop_outbox.set()
        if scheduler is not None:
            scheduler.shutdown(wait=False)
        if is_running():
            print("Finishing the sync in progress before exiting...")
    print("Stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
