"""Settings from .env and the account list from accounts.yaml."""

import os
from dataclasses import dataclass
from pathlib import Path

import keyring
import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", interpolate=False)  # passwords may contain "${" literally

KEYRING_SERVICE = "dashboard-for-all-gmails"


def _path(name: str, default: str) -> Path:
    p = Path(os.getenv(name, default))
    return p if p.is_absolute() else ROOT / p


DB_PATH = _path("DB_PATH", "data/inbox.db")
ACCOUNTS_FILE = _path("ACCOUNTS_FILE", "accounts.yaml")
SYNC_DAYS_BACK = int(os.getenv("SYNC_DAYS_BACK", "14"))
MAX_INITIAL_MESSAGES = int(os.getenv("MAX_INITIAL_MESSAGES", "300"))

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
AI_MODEL = os.getenv("AI_MODEL", "google/gemma-4-26b-a4b-it:free")
AI_FALLBACK_MODEL = os.getenv("AI_FALLBACK_MODEL", "google/gemma-4-26b-a4b-it")
MAX_AI_CALLS_PER_DAY = int(os.getenv("MAX_AI_CALLS_PER_DAY", "50"))


@dataclass
class Account:
    label: str
    email: str
    imap_host: str
    imap_port: int = 993
    folder: str = "INBOX"
    color: str = "#5f6368"
    username: str = ""  # defaults to email

    def __post_init__(self):
        self.username = self.username or self.email


def load_accounts(path: Path = ACCOUNTS_FILE) -> list[Account]:
    if not path.exists():
        raise SystemExit(
            f"{path.name} not found. Copy accounts.example.yaml to accounts.yaml and edit it."
        )
    data = yaml.safe_load(path.read_text()) or {}
    return [Account(**a) for a in data.get("accounts", [])]


# "keyring" (default: macOS Keychain / Windows Credential Manager) or "env" (passwords in .env,
# for servers without a keyring, e.g. a cloud VM). A keyring that fails falls back to .env.
PASSWORD_STORE = os.getenv("PASSWORD_STORE", "keyring").strip().lower()

# Extra host names the dashboard answers to, e.g. the VM's Tailscale name (comma-separated).
ALLOWED_HOSTS = [h.strip().lower() for h in os.getenv("ALLOWED_HOSTS", "").split(",") if h.strip()]

ENV_FILE = ROOT / ".env"

# Optional login for the dashboard (set with: python -m app.cli set-login). Empty = no login,
# which is fine while only you can reach it (your Mac, or Tailscale).
DASHBOARD_PASSWORD_HASH = os.getenv("DASHBOARD_PASSWORD_HASH", "").strip()
DASHBOARD_TOTP_SECRET = os.getenv("DASHBOARD_TOTP_SECRET", "").strip()


def _env_key(email: str) -> str:
    return "IMAP_PASSWORD_" + "".join(c if c.isalnum() else "_" for c in email).upper()


def get_password(email: str) -> str | None:
    """Password from the OS keyring, or IMAP_PASSWORD_<email> in .env as a fallback."""
    pw = None
    if PASSWORD_STORE != "env":
        try:
            pw = keyring.get_password(KEYRING_SERVICE, email)
        except Exception:  # noqa: BLE001 - no usable keyring on this machine
            pw = None
    return pw or os.getenv(_env_key(email))


def set_password(email: str, password: str) -> str:
    """Save a password; returns where it went ("keyring" or ".env")."""
    if PASSWORD_STORE != "env":
        try:
            keyring.set_password(KEYRING_SERVICE, email, password)
            return "keyring"
        except Exception:  # noqa: BLE001 - e.g. a server with no keyring: use .env instead
            pass
    _write_env(_env_key(email), password)
    os.environ[_env_key(email)] = password
    return ".env"


def _write_env(key: str, value: str, path=None) -> None:
    """Set KEY='value' in .env (replacing an old line) and keep the file private (chmod 600)."""
    path = path or ENV_FILE
    quoted = "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    lines = path.read_text().splitlines() if path.exists() else []
    lines = [ln for ln in lines if not ln.split("=", 1)[0].strip() == key]
    lines.append(f"{key}={quoted}")
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o600)
