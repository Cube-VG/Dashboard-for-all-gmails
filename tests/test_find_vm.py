import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "find_vm", Path(__file__).resolve().parent.parent / "deploy" / "find_vm.py")
find_vm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(find_vm)


def peer(host, online=True, dns=None, ips=("100.64.0.7", "fd7a:115c:a1e0::7")):
    return {"HostName": host, "DNSName": f"{dns or host}.tail1234.ts.net.",
            "Online": online, "TailscaleIPs": list(ips)}


def status(*peers, state="Running"):
    return {"BackendState": state, "Self": {"UserID": 42, "HostName": "MacBook-Pro"},
            "User": {"42": {"LoginName": "me@gmail.com"}},
            "Peer": {f"nodekey:{i}": p for i, p in enumerate(peers)}}


def test_finds_the_online_vm_by_ipv4():
    assert find_vm.find_vm(status(peer("iphone"), peer("inbox")), "inbox") == ("100.64.0.7", "")


def test_a_recreated_vm_called_inbox_1_still_matches_and_the_old_offline_one_is_ignored():
    old = peer("inbox", online=False, ips=("100.64.0.1",))
    new = peer("inbox", dns="inbox-1", ips=("100.64.0.2",))
    assert find_vm.find_vm(status(old, new), "inbox") == ("100.64.0.2", "")


def test_two_online_vms_is_a_question_for_the_user():
    ip, problem = find_vm.find_vm(status(peer("inbox", ips=("100.64.0.1",)),
                                         peer("inbox", dns="inbox-1", ips=("100.64.0.2",))), "inbox")
    assert ip is None and "VM=inbox@100.64.0.1" in problem and "VM=inbox@100.64.0.2" in problem


def test_offline_vm_says_how_to_start_it():
    ip, problem = find_vm.find_vm(status(peer("inbox", online=False)), "inbox")
    assert ip is None and "offline" in problem and "Start" in problem


def test_missing_vm_lists_what_the_mac_can_see_and_which_account():
    ip, problem = find_vm.find_vm(status(peer("iphone", online=False)), "inbox")
    assert ip is None
    assert "me@gmail.com" in problem and "iphone (offline)" in problem and "create-vm.sh" in problem


def test_disconnected_tailscale():
    ip, problem = find_vm.find_vm(status(peer("inbox"), state="Stopped"), "inbox")
    assert ip is None and "Stopped" in problem and "menu bar" in problem


def test_ipv6_only_vm_still_works():
    assert find_vm.find_vm(status(peer("inbox", ips=("fd7a::7",))), "inbox") == ("fd7a::7", "")


@pytest.mark.parametrize("stdin,code", [("", 2), ("not json", 2), ("[]", 2),
                                        (json.dumps(status(peer("inbox"))), 0),
                                        (json.dumps(status()), 1)])
def test_exit_codes_for_push_to_vm(monkeypatch, capsys, stdin, code):
    monkeypatch.setattr(sys, "argv", ["find_vm.py", "inbox"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
    assert find_vm.main() == code
    out = capsys.readouterr()
    assert out.out == ("100.64.0.7\n" if code == 0 else "")
    assert bool(out.err) == (code == 1)
