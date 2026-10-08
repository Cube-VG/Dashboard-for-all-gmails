"""Hand a finished email to the account's SMTP server, then (best effort, over IMAP) file a copy
in Sent and flag the email you answered as \\Answered, like any mail app does.

Gmail files mail sent over SMTP in "Sent Mail" by itself, so it gets no extra copy.
"""

import copy
import smtplib
import socket
import ssl
from datetime import datetime, timezone
from email import policy

from imap_tools import MailMessageFlags

from app.sync.imap_sync import connect_mailbox

SMTP_TIMEOUT = 60
SENT_NAMES = ("sent", "sent items", "sent messages", "sent mail", "inbox.sent", "inbox/sent",
              "inbox.sent items", "inbox.sent messages")


def connect_smtp(account) -> smtplib.SMTP:
    """SSL from the start (port 465) or plain + STARTTLS (587); the certificate is always checked."""
    context = ssl.create_default_context()
    if account.smtp_security == "starttls":
        server = smtplib.SMTP(account.smtp_host, account.smtp_port, timeout=SMTP_TIMEOUT)
        try:
            server.starttls(context=context)
        except Exception:
            server.close()
            raise
        return server
    return smtplib.SMTP_SSL(account.smtp_host, account.smtp_port, timeout=SMTP_TIMEOUT,
                            context=context)


def smtp_send(account, password: str, msg, to_addrs: list[str], connect=connect_smtp) -> dict:
    """Send; returns {address: (code, reason)} for recipients the server refused (others got it).
    Raises when nothing was sent. Once the server has accepted the message, an odd goodbye
    (QUIT) can't turn it into a failure that invites sending it twice."""
    server = connect(account)
    try:
        server.login(account.username, password)
        refused = server.send_message(msg, from_addr=account.email, to_addrs=to_addrs) or {}
    except BaseException:
        _close(server)
        raise
    try:
        server.quit()
    except Exception:  # noqa: BLE001 - already sent
        _close(server)
    return refused


def _close(server) -> None:
    try:
        server.close()
    except Exception:  # noqa: BLE001
        pass


def check_login(account, password: str, connect=connect_smtp) -> None:
    """Log in and out again (raises on failure). Used by `python -m app.cli check`."""
    with connect(account) as server:
        server.login(account.username, password)


def friendly_error(exc: Exception, account) -> str:
    """One sentence a person can act on."""
    where = f"{account.smtp_host}:{account.smtp_port}"
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        if 400 <= (exc.smtp_code or 0) < 500:
            return f"The mail server is refusing sign-ins for now ({exc.smtp_code}). Try again in a few minutes."
        hint = "an App Password" if account.is_gmail else "the mailbox password"
        return f"The mail server rejected the password for {account.email}. It needs {hint}."
    if isinstance(exc, smtplib.SMTPNotSupportedError):
        return (f"{where} doesn't support this kind of secure sign-in. Check smtp_port and "
                "smtp_security in accounts.yaml.")
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        who = ", ".join(exc.recipients)[:200]
        return f"The mail server refused every recipient ({who})."
    if isinstance(exc, smtplib.SMTPSenderRefused):
        return f"The mail server won't send from {account.email}: {_reason(exc.smtp_error)}"
    if isinstance(exc, smtplib.SMTPDataError):
        return f"The mail server refused the message: {exc.smtp_code} {_reason(exc.smtp_error)}"
    if isinstance(exc, smtplib.SMTPResponseException):
        return f"The mail server said: {exc.smtp_code} {_reason(exc.smtp_error)}"
    if isinstance(exc, (socket.timeout, TimeoutError, smtplib.SMTPServerDisconnected)):
        return (f"The mail server {where} stopped answering. It may or may not have been sent: "
                "check your Sent folder before trying again.")
    if isinstance(exc, ssl.SSLError):
        return (f"Couldn't make a secure connection to {where} ({exc.reason or exc}). "
                "Check smtp_port and smtp_security in accounts.yaml.")
    if isinstance(exc, socket.gaierror):
        return f"Couldn't find the mail server {account.smtp_host}. Check smtp_host in accounts.yaml."
    if isinstance(exc, (ConnectionError, smtplib.SMTPConnectError)) or (
            isinstance(exc, OSError) and not isinstance(exc, smtplib.SMTPException)):
        return f"Couldn't reach the mail server {where} ({exc})."
    return f"Sending failed: {exc}"[:300]


def _reason(raw) -> str:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return str(raw or "").strip()[:200]


def find_sent_folder(mailbox) -> str | None:
    """The folder the server marks as \\Sent, else one with a usual name."""
    folders = mailbox.folder.list()
    for f in folders:
        if any(flag.lower() == "\\sent" for flag in f.flags):
            return f.name
    by_name = {f.name.lower(): f.name for f in folders}
    return next((by_name[n] for n in SENT_NAMES if n in by_name), None)


def file_and_flag(account, password: str, msg, answered_uid: int | None = None,
                  uidvalidity: int | None = None, mailbox_factory=connect_mailbox,
                  bcc: str = "", answered_folder: str | None = None) -> list[str]:
    """After a successful send: copy to Sent (not for Gmail; with Bcc, like any mail app keeps
    it) and flag the original \\Answered in its folder. Never raises; returns notes about
    anything that didn't work (the mail itself went out)."""
    save_copy = not account.is_gmail
    if not save_copy and answered_uid is None:
        return []
    notes = []
    try:
        with mailbox_factory(account.imap_host, account.imap_port).login(
                account.username, password, initial_folder=None) as mailbox:
            if save_copy:
                folder = account.sent_folder or find_sent_folder(mailbox)
                if folder:
                    kept = msg
                    if bcc:
                        kept = copy.deepcopy(msg)
                        kept["Bcc"] = bcc
                    mailbox.append(kept.as_bytes(policy=policy.SMTP), folder,
                                   dt=datetime.now(timezone.utc), flag_set=[MailMessageFlags.SEEN])
                else:
                    notes.append("no Sent folder found, so no copy was saved there")
            if answered_uid is not None:
                folder = answered_folder or account.folder
                status = mailbox.folder.status(folder, ["UIDVALIDITY"])
                if uidvalidity is None or int(status["UIDVALIDITY"]) == int(uidvalidity):
                    mailbox.folder.set(folder)
                    mailbox.flag(str(answered_uid), MailMessageFlags.ANSWERED, True)
    except Exception as exc:  # noqa: BLE001 - the mail is sent; this is bookkeeping
        notes.append(f"couldn't update the mailbox afterwards ({exc})"[:200])
    return notes
