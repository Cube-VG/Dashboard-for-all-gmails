"""Desktop notifications using only what the OS already has.

Windows: a PowerShell toast (tray balloon as a fallback). macOS: osascript.
Linux: notify-send. Set NOTIFICATIONS=0 in .env to turn them off.
"""

import base64
import logging
import os
import platform
import shutil
import subprocess

log = logging.getLogger(__name__)

TIMEOUT = 15  # seconds; a stuck notifier must never hold up the sync
OFF = {"0", "false", "no", "off"}

# Title and text come in through environment variables, so nothing in an email can
# break out of the script. Toasts need Windows 10+; otherwise show a tray balloon.
WINDOWS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$title = $env:INBOX_NOTIFY_TITLE
$text = $env:INBOX_NOTIFY_TEXT
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $t = [Security.SecurityElement]::Escape($title)
    $m = [Security.SecurityElement]::Escape($text)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text></binding></visual></toast>")
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show(
        [Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.ShowBalloonTip(8000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 8
    $icon.Dispose()
}
"""

MAC_SCRIPT = ("on run argv", "display notification (item 2 of argv) with title (item 1 of argv)",
              "end run")


def _clean(text: str, limit: int) -> str:
    text = str(text or "").replace("\x00", "").strip()
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _command(title: str, message: str) -> tuple[list[str], dict | None] | None:
    """The notifier command for this OS (args list, env), or None if there is none."""
    system = platform.system()
    if system == "Windows":
        exe = shutil.which("powershell")  # Windows PowerShell 5.1: pwsh 7 can't load WinRT types
        if not exe:
            return None
        encoded = base64.b64encode(WINDOWS_SCRIPT.encode("utf-16-le")).decode("ascii")
        env = {**os.environ, "INBOX_NOTIFY_TITLE": title, "INBOX_NOTIFY_TEXT": message}
        return [exe, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], env
    if system == "Darwin":
        exe = shutil.which("osascript")
        if not exe:
            return None
        args = [exe]
        for line in MAC_SCRIPT:
            args += ["-e", line]
        return [*args, "--", title, message], None
    exe = shutil.which("notify-send")
    return ([exe, "--", title, message], None) if exe else None


def notify(title: str, message: str) -> bool:
    """Show a desktop notification. Returns False (and never raises) if it wasn't shown."""
    if os.getenv("NOTIFICATIONS", "1").strip().lower() in OFF:
        return False
    try:
        title, message = _clean(title, 100), _clean(message, 300) or " "
        cmd = _command(title, message)
        if cmd is None:
            log.info("No desktop notifier available. %s: %s", title, message)
            return False
        args, env = cmd
        result = subprocess.run(
            args, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),  # no console flash on Windows
        )
        if result.returncode != 0:
            err = (result.stderr or b"").decode(errors="replace").strip()
            log.warning("Notification failed (exit %s): %s", result.returncode, err[:300])
            return False
        return True
    except Exception as exc:  # noqa: BLE001 - a notification is never worth a crash
        log.warning("Notification failed: %s", exc)
        return False
