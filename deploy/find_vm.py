"""Find the VM in this Mac's Tailscale and print the address to ssh to.

Used by push-to-vm.sh:   tailscale status --json | python deploy/find_vm.py inbox
Prints the VM's Tailscale IP (exit 0), or explains what to do (exit 1), or exit 2 when the
status can't be read. Going by IP works even when this Mac can't look up Tailscale names.
"""

import json
import sys


def _short(peer: dict) -> str:
    return (peer.get("DNSName") or "").split(".")[0].lower() or (peer.get("HostName") or "").lower()


def find_vm(status: dict, name: str) -> tuple[str | None, str]:
    """(ip, "") when exactly one online machine has this name, else (None, what to do)."""
    state = status.get("BackendState") or "unknown"
    if state != "Running":
        return None, (f"Tailscale on this Mac isn't connected (it says: {state}).\n"
                      "Click the Tailscale icon in the menu bar, sign in and switch it on, then run this again.")
    name = name.lower()
    peers = [p for p in (status.get("Peer") or {}).values() if isinstance(p, dict)]
    # create-vm.sh names it "inbox"; Tailscale calls a second one "inbox-1" but keeps its HostName
    named = [p for p in peers if (p.get("HostName") or "").lower() == name or _short(p) == name]
    online = [p for p in named if p.get("Online") and not p.get("Expired")]
    expired = [p for p in named if p.get("Expired")]

    if len(online) == 1:
        ips = online[0].get("TailscaleIPs") or []
        ip = next((i for i in ips if ":" not in i), ips[0] if ips else None)
        if ip:
            return ip, ""
    if len(online) > 1:
        choices = "\n".join(f"  VM=inbox@{(p.get('TailscaleIPs') or ['?'])[0]} bash deploy/push-to-vm.sh --all"
                            f"    ({_short(p)})" for p in online)
        return None, (f"More than one online machine is called '{name}'. Remove the one you don't use at\n"
                      f"https://login.tailscale.com/admin/machines , or pick one:\n{choices}")
    if expired:
        label = _short(expired[0])
        return None, (f"'{label}' is in your Tailscale but its Tailscale login expired.\n"
                      f"Open https://login.tailscale.com/admin/machines -> {label} -> ... -> Temporarily extend key,\n"
                      f"then ... -> Disable key expiry. It reconnects by itself within a minute; then run this again.")
    if named:
        return None, (f"'{name}' is in your Tailscale but offline. If you created it in the last few minutes, wait\n"
                      f"a minute and run this again. Otherwise start it: https://console.cloud.google.com/compute/instances\n"
                      f"-> {name} -> Start (or Reset if it's already running).\n"
                      "Still offline 3 minutes later? Make a new auth key and, in Cloud Shell, run:\n"
                      "  bash create-vm.sh --rejoin tskey-auth-NEW-KEY")

    me = status.get("Self") or {}
    login = ((status.get("User") or {}).get(str(me.get("UserID"))) or {}).get("LoginName")
    seen = ", ".join(f"{_short(p)} ({'online' if p.get('Online') else 'offline'})" for p in peers)
    return None, (f"This Mac's Tailscale{f' ({login})' if login else ''} doesn't have a machine called '{name}'.\n"
                  f"Machines it can see: {seen or 'none besides this Mac'}.\n"
                  "- Did create-vm.sh in Cloud Shell finish with 'Done'? If not, do step 2 of docs/DEPLOY.md\n"
                  "  (running it again is safe).\n"
                  "- Is this Mac signed in to the same Tailscale account you made the auth key in?")


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "inbox"
    try:
        status = json.load(sys.stdin)
    except ValueError:
        return 2
    if not isinstance(status, dict):
        return 2
    ip, problem = find_vm(status, name)
    if ip:
        print(ip)
        return 0
    print(problem, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
