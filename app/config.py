"""Settings from .env and the account list from accounts.yaml."""

import os
from dataclasses import dataclass
from pathlib import Path

import keyring
import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

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


def get_password(email: str) -> str | None:
    """Password from the OS keyring, or IMAP_PASSWORD_<email> in .env as a fallback."""
    try:
        pw = keyring.get_password(KEYRING_SERVICE, email)
    except keyring.errors.KeyringError:
        pw = None
    if pw:
        return pw
    env_key = "IMAP_PASSWORD_" + "".join(c if c.isalnum() else "_" for c in email).upper()
    return os.getenv(env_key)


def set_password(email: str, password: str) -> None:
    keyring.set_password(KEYRING_SERVICE, email, password)
