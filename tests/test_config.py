import os
import stat

import pytest
from dotenv import dotenv_values

from app import config


@pytest.mark.parametrize("pw", ["abcdefghijklmnop", "p@ss word#1", "it's \\ \"quoted\" $HOME", "ünïcødé=="])
def test_password_saved_to_env_file_round_trips(tmp_path, monkeypatch, pw):
    env = tmp_path / ".env"
    env.write_text("OPENROUTER_API_KEY=sk-or-x\nIMAP_PASSWORD_ME_EXAMPLE_COM='old'\n")
    monkeypatch.setattr(config, "ENV_FILE", env)
    monkeypatch.setattr(config, "PASSWORD_STORE", "env")
    monkeypatch.delenv("IMAP_PASSWORD_ME_EXAMPLE_COM", raising=False)
    assert config.set_password("me@example.com", pw) == ".env"
    assert dotenv_values(env) == {"OPENROUTER_API_KEY": "sk-or-x", "IMAP_PASSWORD_ME_EXAMPLE_COM": pw}
    assert stat.S_IMODE(os.stat(env).st_mode) == 0o600
    assert config.get_password("me@example.com") == pw


def test_broken_keyring_falls_back_to_env(tmp_path, monkeypatch):
    def boom(*a):
        raise RuntimeError("no keyring backend")
    monkeypatch.setattr(config, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(config, "PASSWORD_STORE", "keyring")
    monkeypatch.setattr(config.keyring, "set_password", boom)
    monkeypatch.setattr(config.keyring, "get_password", boom)
    monkeypatch.delenv("IMAP_PASSWORD_VM_EXAMPLE_COM", raising=False)
    assert config.set_password("vm@example.com", "secret") == ".env"
    assert config.get_password("vm@example.com") == "secret"
