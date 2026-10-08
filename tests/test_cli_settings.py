import io
import json
import os
import stat
import sys

import pytest
from dotenv import dotenv_values

from app import cli, config


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """A fake project folder: .env, accounts.yaml and .env-stored passwords."""
    env, acc = tmp_path / ".env", tmp_path / "accounts.yaml"
    monkeypatch.setattr(config, "ENV_FILE", env)
    monkeypatch.setattr(config, "ACCOUNTS_FILE", acc)
    monkeypatch.setattr(config, "PASSWORD_STORE", "env")
    return env, acc


def test_settings_move_from_mac_to_vm(machine, monkeypatch, capsys):
    env, acc = machine
    acc.write_text("accounts:\n  - label: Me\n    email: me@gmail.com\n    imap_host: imap.gmail.com\n")
    for k in ("IMAP_PASSWORD_ME_GMAIL_COM",):
        monkeypatch.delenv(k, raising=False)
    config.set_password("me@gmail.com", "abcd'efgh${x}")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("AI_MODEL", "google/gemma-4-26b-a4b-it")
    monkeypatch.setenv("DASHBOARD_PASSWORD_HASH", "should-not-travel")
    real_stdout, buf = sys.stdout, io.StringIO()
    sys.stdout = buf
    try:
        cli.cmd_export_settings(None)
    finally:
        sys.stdout = real_stdout
    blob = buf.getvalue()
    data = json.loads(blob)
    assert data["passwords"] == {"me@gmail.com": "abcd'efgh${x}"}
    assert data["env"] == {"OPENROUTER_API_KEY": "sk-or-test", "AI_MODEL": "google/gemma-4-26b-a4b-it"}

    # the "VM": an empty folder
    env.unlink(); acc.unlink()
    monkeypatch.delenv("IMAP_PASSWORD_ME_GMAIL_COM", raising=False)
    monkeypatch.setattr(sys, "stdin", io.StringIO(blob))
    cli.cmd_import_settings(None)
    assert "Imported 1 mailbox password(s) (stored in .env)" in capsys.readouterr().out
    values = dotenv_values(env, interpolate=False)
    assert values["IMAP_PASSWORD_ME_GMAIL_COM"] == "abcd'efgh${x}"
    assert values["OPENROUTER_API_KEY"] == "sk-or-test" and "DASHBOARD_PASSWORD_HASH" not in values
    assert stat.S_IMODE(os.stat(env).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(acc).st_mode) == 0o600
    assert "me@gmail.com" in acc.read_text()


def test_export_refuses_to_print_secrets_to_the_screen(machine, monkeypatch):
    class Tty(io.StringIO):
        def isatty(self):
            return True
    monkeypatch.setattr(sys, "stdout", Tty())
    with pytest.raises(SystemExit, match="pipe it"):
        cli.cmd_export_settings(None)


def test_import_ignores_settings_that_belong_to_each_machine(machine, monkeypatch):
    env, _ = machine
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(
        {"env": {"DASHBOARD_PASSWORD_HASH": "x", "ALLOWED_HOSTS": "evil", "AI_MODEL": "m"}})))
    cli.cmd_import_settings(None)
    assert dotenv_values(env) == {"AI_MODEL": "m"}
