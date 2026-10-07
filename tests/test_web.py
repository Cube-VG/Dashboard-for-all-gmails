import re
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.web.main import create_app, gmail_url

NOW = datetime.now(timezone.utc)
JSON = {"Accept": "application/json"}


def mail(uid, subject, hours_ago, sender="alice@example.com", name="Alice", body="Hello there",
         read=0, attach=0):
    return {
        "uid": uid, "message_id": f"<m{uid}.{sender}>", "from_name": name, "from_email": sender,
        "to_email": "me@gmail.com", "subject": subject, "snippet": body[:300], "body_text": body,
        "received_at": (NOW - timedelta(hours=hours_ago)).isoformat(), "is_read": read,
        "has_attachments": attach, "list_unsubscribe": None,
    }


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "inbox.db"
    conn = db.connect(path)
    gmail = db.upsert_account(conn, "me@gmail.com", "INBOX", "Personal", "#d93025")
    shop = db.upsert_account(conn, "info@shop.example", "INBOX", "Shop", "#188038")
    db.insert_messages(conn, gmail["id"], [
        mail(1, "Contract needs signature", 5, sender="boss@corp.com", name="Boss"),
        mail(2, "Quarterly planning", 3, sender="pm@corp.com", name="Pat"),
        mail(3, "Your code is 123456", 1, sender="noreply@bank.com", name="Bank"),
        mail(4, "Weekly newsletter", 10, sender="news@letters.com", name="Letters", read=1),
        mail(5, "<script>alert(1)</script>", 2, sender="evil@hack.er", name="Mallory",
             body="<b>bold</b> & <img src=x onerror=alert(1)>"),
        mail(6, "Budget review", 0.5, sender="cfo@corp.com", name="Chris"),
    ])
    db.insert_messages(conn, shop["id"], [
        mail(1, "Order #42 refund request", 4, sender="customer@buyer.com", name="Customer", attach=1),
        mail(2, "Server down!", 6, sender="ops@host.com", name="Ops", read=1),
    ])
    ids = {r["subject"]: r["id"] for r in conn.execute("SELECT id, subject FROM messages")}
    scores = {
        "Contract needs signature": ({"importance": 5, "urgency": 5, "category": "work",
                                      "deadline": date.today().isoformat(),
                                      "summary": "Boss needs the contract signed today",
                                      "reason": "Direct request with a deadline"}, "gemma"),
        "Server down!": ({"importance": 4, "urgency": 5, "category": "alert"}, "gemma"),
        "Quarterly planning": ({"importance": 5, "urgency": 2, "category": "work"}, "gemma"),
        "Budget review": ({"importance": 5, "urgency": 2, "category": "finance"}, "gemma"),
        "Your code is 123456": ({"importance": 2, "urgency": 5, "category": "otp",
                                 "reason": "One-time code"}, "rule"),
        "Weekly newsletter": ({"importance": 1, "urgency": 1, "category": "newsletter"}, "rule"),
    }
    for subject, (s, by) in scores.items():
        db.save_scores(conn, ids[subject], s, by)
    conn.commit()
    conn.close()
    return SimpleNamespace(path=path, ids=ids, gmail=gmail["id"], shop=shop["id"],
                           client=TestClient(create_app(conn_factory=lambda: db.connect(path))))


def query(env, sql, *args):
    conn = db.connect(env.path)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def columns(html: str) -> dict[str, list[int]]:
    """Card ids per matrix column / list section, in page order."""
    return {key: [int(i) for i in re.findall(r'data-id="(\d+)"', body)]
            for key, body in re.findall(r'<section[^>]*data-col="(\w+)"[^>]*>(.*?)</section>', html, re.S)}


def listed(env, **params) -> list[int]:
    r = env.client.get("/", params={"view": "list", **params})
    assert r.status_code == 200
    return columns(r.text).get("list", [])


def test_matrix_groups_and_sorts(env):
    r = env.client.get("/")
    assert r.status_code == 200
    i = env.ids
    assert columns(r.text) == {
        "unsorted": [i["<script>alert(1)</script>"], i["Order #42 refund request"]],  # newest first
        "do": [i["Contract needs signature"], i["Server down!"]],
        "schedule": [i["Budget review"], i["Quarterly planning"]],  # same score: newest first
        "quick": [i["Your code is 123456"]],
        "later": [i["Weekly newsletter"]],
    }
    # "later" starts collapsed, the others open
    assert re.search(r'<details data-key="later">', r.text)
    assert re.search(r'<details open data-key="do">', r.text)
    # unread "do now" count in the title
    assert "<title>(1) " in r.text


def test_list_view_sorts_by_priority_then_date(env):
    i = env.ids
    assert listed(env) == [
        i["Contract needs signature"], i["Server down!"], i["Budget review"],
        i["Quarterly planning"], i["Your code is 123456"], i["Weekly newsletter"],
        i["<script>alert(1)</script>"], i["Order #42 refund request"],  # unscored last
    ]


def test_card_details(env):
    html = env.client.get("/").text
    assert "Boss needs the contract signed today" in html  # AI summary
    assert "due today" in html and 'class="chip due soon"' in html
    assert "Direct request with a deadline" in html and "scored by Gemma" in html
    assert "scored by a rule" in html
    assert 'aria-label="Has attachments"' in html
    assert "--c: #d93025" in html  # account color
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "<script>alert(1)" not in html


def test_filters(env):
    i = env.ids
    assert set(listed(env, account="info@shop.example")) == {i["Order #42 refund request"], i["Server down!"]}
    assert listed(env, q="refund") == [i["Order #42 refund request"]]
    assert listed(env, q="boss@corp") == [i["Contract needs signature"]]  # from_email
    assert listed(env, q="mallory") == [i["<script>alert(1)</script>"]]  # from_name
    assert listed(env, q="hello there") != []  # snippet
    assert listed(env, q="%") == []  # LIKE wildcards are escaped
    unread = listed(env, unread="1")
    assert i["Server down!"] not in unread and i["Weekly newsletter"] not in unread
    assert len(unread) == 6
    assert listed(env, category="otp") == [i["Your code is 123456"]]
    assert listed(env, account="me@gmail.com", unread="1", q="corp") == [
        i["Contract needs signature"], i["Budget review"], i["Quarterly planning"]]


def test_filters_apply_to_matrix_and_are_kept_across_views(env):
    r = env.client.get("/", params={"account": "info@shop.example"})
    cols = columns(r.text)
    assert cols["do"] == [env.ids["Server down!"]] and cols["schedule"] == []
    assert 'href="/?view=list&amp;account=info%40shop.example"' in r.text
    r = env.client.get("/", params={"view": "list", "q": "x", "unread": "1"})
    assert 'href="/?q=x&amp;unread=1"' in r.text  # back to matrix keeps filters
    assert "Clear filters" in r.text


def test_no_match_and_empty_states(env, tmp_path):
    assert "Nothing matches" in env.client.get("/", params={"q": "zzzz"}).text
    empty = tmp_path / "empty.db"
    client = TestClient(create_app(conn_factory=lambda: db.connect(empty)))
    assert "No email yet" in client.get("/").text


def test_detail_escapes_html(env):
    r = env.client.get(f"/message/{env.ids['<script>alert(1)</script>']}")
    assert r.status_code == 200
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in r.text
    assert "&lt;b&gt;bold&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt;" in r.text
    assert "<script>alert" not in r.text and "<img src=x" not in r.text and "<b>bold" not in r.text
    assert "Open in Gmail" in r.text  # gmail account
    assert r.headers["content-security-policy"].startswith("default-src 'self'")


def test_gmail_link(env):
    r = env.client.get(f"/message/{env.ids['Contract needs signature']}")
    assert 'href="https://mail.google.com/mail/u/me@gmail.com/#search/rfc822msgid:m1.boss%40corp.com"' in r.text
    r = env.client.get(f"/message/{env.ids['Server down!']}")
    assert "Open in Gmail" not in r.text  # hosting account
    assert gmail_url("x@googlemail.com", "<a+b/c@d>") == \
        "https://mail.google.com/mail/u/x@googlemail.com/#search/rfc822msgid:a%2Bb%2Fc%40d"
    assert gmail_url("x@notgmail.com", "<a@b>") is None
    assert gmail_url("x@gmail.com", None) is None


def test_detail_fragment_and_open_pane(env):
    mid = env.ids["Quarterly planning"]
    r = env.client.get(f"/message/{mid}", params={"partial": "1", "next": f"/?view=list&open={mid}"})
    assert r.status_code == 200 and "<html" not in r.text
    assert f'name="next" value="/?view=list&amp;open={mid}"' in r.text
    assert 'href="/?view=list" data-close' in r.text
    r = env.client.get(f"/message/{mid}", params={"partial": "1", "next": "//evil.example/"})
    assert 'value="//evil.example/"' not in r.text
    r = env.client.get("/", params={"open": mid})
    assert 'class="layout with-pane"' in r.text
    assert f'class="card unread active" data-id="{mid}"' in r.text
    assert env.client.get("/message/9999").status_code == 404
    assert "Message not found" in env.client.get("/message/9999", headers={"Accept": "text/html"}).text


def test_score_correction_writes_feedback_and_moves_card(env):
    mid = env.ids["Quarterly planning"]
    r = env.client.post(f"/message/{mid}/score", data={"move": "do", "next": "/"})
    assert r.status_code == 200 and "Moved to “Do now”" in r.text  # flash after redirect
    assert mid in columns(r.text)["do"] and mid not in columns(r.text)["schedule"]
    fb = query(env, "SELECT * FROM feedback WHERE message_id = ?", mid)
    assert [(f["old_importance"], f["old_urgency"], f["new_importance"], f["new_urgency"]) for f in fb] == [(5, 2, 5, 5)]
    assert query(env, "SELECT scored_by FROM messages WHERE id = ?", mid)[0][0] == "user"
    assert "scored by you" in env.client.get(f"/message/{mid}").text

    r = env.client.post(f"/message/{mid}/score", headers=JSON,
                        data={"importance": "1", "urgency": "2", "category": " Finance "})
    assert r.json() == {"ok": True, "message": r.json()["message"], "importance": 1, "urgency": 2,
                        "quadrant": "later"}
    row = query(env, "SELECT importance, urgency, category FROM messages WHERE id = ?", mid)[0]
    assert tuple(row) == (1, 2, "finance")
    assert mid in columns(env.client.get("/").text)["later"]


@pytest.mark.parametrize("data", [
    {"importance": "9", "urgency": "2"}, {"importance": "x", "urgency": "2"}, {"urgency": "3"},
    {"move": "nowhere"}, {"importance": "3", "urgency": "3", "category": "<b>"},
])
def test_score_validation(env, data):
    mid = env.ids["Quarterly planning"]
    r = env.client.post(f"/message/{mid}/score", headers=JSON, data=data)
    assert r.status_code == 400 and r.json()["ok"] is False
    assert query(env, "SELECT COUNT(*) FROM feedback")[0][0] == 0


def test_score_validation_without_js_flashes_error(env):
    mid = env.ids["Quarterly planning"]
    r = env.client.post(f"/message/{mid}/score", data={"importance": "0", "urgency": "9", "next": "/"})
    assert r.status_code == 200 and 'class="flash err"' in r.text and "1 to 5" in r.text
    assert env.client.post("/message/9999/score", data={"move": "do"}).status_code == 404


def test_read_toggle(env):
    mid = env.ids["Contract needs signature"]
    r = env.client.post(f"/message/{mid}/read", data={"is_read": "1", "next": f"/message/{mid}"})
    assert r.status_code == 200 and "Marked as read" in r.text and "Mark unread" in r.text
    row = query(env, "SELECT is_read, priority_score FROM messages WHERE id = ?", mid)[0]
    assert tuple(row) == (1, 5.5)  # read costs 0.5 priority
    assert "<title>Contract" in r.text  # no unread "do" left, no badge
    r = env.client.post(f"/message/{mid}/read", headers=JSON)  # no value: toggle
    assert r.json()["is_read"] is False
    assert query(env, "SELECT is_read FROM messages WHERE id = ?", mid)[0][0] == 0
    assert env.client.post("/message/9999/read").status_code == 404


def test_rules_add_and_delete(env):
    r = env.client.post("/rules", data={"kind": "vip", "pattern": " Boss@Corp.com "})
    assert r.status_code == 200 and "Rule saved" in r.text  # redirected to /rules
    env.client.post("/rules", data={"kind": "private", "pattern": "bank.com"})
    env.client.post("/rules", data={"kind": "low", "pattern": "@letters.com", "next": "/"})
    rules = {(x["kind"], x["pattern"]) for x in query(env, "SELECT * FROM rules")}
    assert rules == {("vip", "boss@corp.com"), ("private", "@bank.com"), ("low", "@letters.com")}

    page = env.client.get("/rules").text
    assert "boss@corp.com" in page and "@bank.com" in page and "1 email " in page

    detail = env.client.get(f"/message/{env.ids['Contract needs signature']}").text
    assert '<option value="@corp.com">' in detail
    assert "Always important (VIP) · boss@corp.com" in detail  # active rule shown

    bad = env.client.post("/rules", headers=JSON, data={"kind": "nope", "pattern": "a@b.com"})
    assert bad.status_code == 400
    bad = env.client.post("/rules", headers=JSON, data={"kind": "vip", "pattern": "not an address"})
    assert bad.status_code == 400

    rule_id = query(env, "SELECT id FROM rules WHERE pattern = 'boss@corp.com'")[0][0]
    r = env.client.post(f"/rules/{rule_id}/delete")
    assert r.status_code == 200 and "Rule removed" in r.text
    assert len(query(env, "SELECT * FROM rules")) == 2


def test_sync_without_handler(env):
    r = env.client.post("/sync", data={"next": "/?view=list"})
    assert r.status_code == 200 and "Sync not available" in r.text
    assert r.url.query == b"view=list"
    r = env.client.post("/sync", headers=JSON)
    assert r.status_code == 503 and r.json()["ok"] is False
    assert "not available" in r.json()["message"]


def test_sync_with_handler(env):
    calls = []

    def run():
        calls.append(1)
        return {"me@gmail.com": 3, "info@shop.example": "error: login failed", "scored": 2}

    client = TestClient(create_app(conn_factory=lambda: db.connect(env.path), on_sync_now=run))
    r = client.post("/sync", data={"next": "/"})
    assert calls == [1] and r.status_code == 200
    assert "Sync done. me@gmail.com: 3; info@shop.example: error: login failed; scored: 2" in r.text
    assert "Sync done" not in client.get("/").text  # the flash shows once
    r = client.post("/sync", headers=JSON)
    assert r.json()["ok"] is True and r.json()["result"]["scored"] == 2

    def boom():
        raise RuntimeError("no network")

    client = TestClient(create_app(conn_factory=lambda: db.connect(env.path), on_sync_now=boom))
    r = client.post("/sync", headers=JSON)
    assert r.status_code == 500 and r.json()["message"] == "Sync failed: no network"


@pytest.mark.parametrize("result, message, ok", [
    ({"sync": {"a@gmail.com": 3, "b@x.com": 1}, "classify": {"rule_scored": 1, "ai_scored": 2,
      "failed": 0, "skipped_budget": 0}, "notified": 0},
     "Sync done: 4 new emails, 3 sorted", True),
    ({"sync": None, "classify": {"rule_scored": 0, "ai_scored": 0, "failed": 0, "skipped_budget": 5},
      "error": "accounts: accounts.yaml not found"},
     "Sync done: 0 sorted, 5 waiting for the AI. Problem: accounts: accounts.yaml not found", False),
    ({"status": "already running"}, "A sync is already running, try again in a moment", False),
])
def test_sync_with_runner_result(env, result, message, ok):
    client = TestClient(create_app(conn_factory=lambda: db.connect(env.path), on_sync_now=lambda: result))
    r = client.post("/sync", headers=JSON)
    assert r.status_code == 200 and r.json()["ok"] is ok and r.json()["message"] == message


def test_status_strip(env):
    conn = db.connect(env.path)
    db.mark_synced(conn, env.gmail, 6)
    db.mark_synced(conn, env.shop, 2, error="LOGIN failed: bad password")
    day = datetime.now(timezone.utc).date().isoformat()
    db.count_ai_call(conn, day)
    db.count_ai_call(conn, day)
    conn.commit()
    conn.close()
    html = env.client.get("/").text
    status = html.split('id="status"', 1)[1].split("</div>", 1)[0]
    assert "<b>Personal</b>" in status and "synced just now" in status
    assert 'class="acct-status err"' in status and "LOGIN failed: bad password" in status
    assert f"AI calls today: 2 / {config.MAX_AI_CALLS_PER_DAY}" in status
    assert 'class="banner warn"' in html and "can't sign in" in html  # says how to fix it
    assert "set-password info@shop.example" in html and "Retry sync" in html
    assert "1 problem" in html


def test_api_stats(env):
    s = env.client.get("/api/stats").json()
    assert s["quadrants"] == {"do": 2, "schedule": 2, "quick": 1, "later": 1}
    assert s["quadrant_unread"] == {"do": 1, "schedule": 2, "quick": 1, "later": 0}
    assert (s["total"], s["unread"], s["unscored"], s["unread_do"]) == (8, 6, 2, 1)
    assert s["ai_calls_today"] == 0 and s["ai_calls_max"] == config.MAX_AI_CALLS_PER_DAY


def test_cross_site_posts_are_blocked(env):
    mid = env.ids["Contract needs signature"]
    r = env.client.post(f"/message/{mid}/read", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert query(env, "SELECT is_read FROM messages WHERE id = ?", mid)[0][0] == 0
    r = env.client.post(f"/message/{mid}/read", headers={"Origin": "http://testserver", **JSON})
    assert r.status_code == 200
    assert env.client.get("/", headers={"Host": "evil.example"}).status_code == 400


def test_static_files_are_local(env):
    html = env.client.get("/").text
    assert not re.search(r'(src|href)="(https?:)?//', html.split("<body>")[0])  # no CDN
    assert env.client.get("/static/style.css").status_code == 200
    assert env.client.get("/static/app.js").status_code == 200
    assert env.client.get("/static/prefs.js").status_code == 200


def test_board_head_columns_and_dock(env):
    html = env.client.get("/").text
    assert '<h1 class="hero"><span class="num">1</span> to do now</h1>' in html  # same number as the tab badge
    do = html.split('data-col="do"', 1)[1].split("</section>", 1)[0]
    assert "<b>1 new</b> · 2" in do and "1 unread of 2" in do
    assert 'class="dock glass"' in html and 'href="#col-do"' in html
    later = html.split('data-col="later"', 1)[1].split("</section>", 1)[0]
    assert "Nothing parked here." not in later  # has a card
    # per-card "why?" moved into a tooltip; the pane has the full reason
    assert "Why: Direct request with a deadline · scored by Gemma" in html


def test_sorting_strip_replaces_the_unsorted_wall(env):
    html = env.client.get("/").text
    strip = html.split('data-col="unsorted"', 1)[1].split("</section>", 1)[0]
    assert '<details data-key="unsorted-v2">' in strip  # closed by default
    assert "6 of 8 sorted" in strip and "2 waiting" in strip
    assert 'aria-valuenow="6"' in strip and 'aria-valuemax="8"' in strip
    assert "Needs ≈1 AI call · " in strip
    assert 'href="/?view=list&amp;sorted=no"' in strip  # "See all … in List" never dead-ends


def test_unsorted_filter(env):
    i = env.ids
    assert listed(env, sorted="no") == [i["<script>alert(1)</script>"], i["Order #42 refund request"]]
    r = env.client.get("/", params={"view": "list", "sorted": "no"})
    assert "Not sorted yet" in r.text and "Clear filters" in r.text
    assert 'href="/?view=list"' in r.text  # removing the filter keeps the view
    assert 'name="sorted" value="no"' in r.text  # search keeps the filter


def test_all_caught_up_and_empty_columns(env):
    conn = db.connect(env.path)
    conn.execute("UPDATE messages SET is_read = 1")
    conn.commit()
    conn.close()
    r = env.client.get("/", params={"unread": "1"})
    assert "All caught up" in r.text and "Show read mail" in r.text
    assert "Nothing matches" not in r.text
    r = env.client.get("/", params={"q": "Weekly"})
    assert "Nothing to plan." in r.text and "Nothing urgent. You&#39;re clear." in r.text


def test_rule_copy_and_removable_rule_chips(env):
    r = env.client.post("/rules", headers=JSON, data={"kind": "vip", "pattern": "boss@corp.com"})
    assert r.json()["message"].endswith("It also sorts mail that's still waiting.")
    rule_id = query(env, "SELECT id FROM rules WHERE pattern = 'boss@corp.com'")[0][0]
    detail = env.client.get(f"/message/{env.ids['Contract needs signature']}").text
    assert 'data-kind="vip" data-pattern="boss@corp.com"' in detail  # lets JS undo the removal
    assert f'action="/rules/{rule_id}/delete"' in detail
    page = env.client.get("/rules").text
    assert 'data-kind="vip" data-pattern="boss@corp.com"' in page
    assert 'aria-label="Remove rule boss@corp.com"' in page


def test_rules_page_shows_bad_input_inline_without_js(env):
    r = env.client.post("/rules", data={"kind": "vip", "pattern": "nope", "next": "/rules"})
    assert r.status_code == 200 and 'class="field-error"' in r.text and 'aria-invalid="true"' in r.text


def test_forms_work_without_js(env):
    # `no-referrer` makes browsers send `Origin: null` with plain form posts, which the
    # cross-site guard must reject; `same-origin` keeps the real Origin on our own forms
    assert env.client.get("/").headers["referrer-policy"] == "same-origin"
    mid = env.ids["Contract needs signature"]
    r = env.client.post(f"/message/{mid}/read", data={"is_read": "1", "next": "/"},
                        headers={"Origin": "http://testserver"})
    assert r.status_code == 200 and "Marked as read" in r.text
    r = env.client.post(f"/message/{mid}/read", headers={"Origin": "null"})
    assert r.status_code == 403  # sandboxed frames still blocked


def test_rejected_rule_keeps_what_was_typed(env):
    r = env.client.post("/rules", data={"kind": "low", "pattern": "boss at corp", "next": "/rules"})
    assert r.status_code == 200 and 'class="field-error"' in r.text
    assert 'value="boss at corp"' in r.text
    assert re.search(r'value="low" checked', r.text)
    assert not re.search(r'value="vip" checked', r.text)
    # from the pane the pattern comes from a select; the redirect target is left alone
    r = env.client.post("/rules", data={"kind": "vip", "pattern": "x", "next": "/?view=list"},
                        follow_redirects=False)
    assert r.headers["location"] == "/?view=list"


def test_category_menu_only_offers_categories_with_mail(env):
    html = env.client.get("/").text
    assert '<option value="otp">' in html and '<option value="alert">' in html
    html = env.client.get("/", params={"account": "info@shop.example"}).text
    menu = html.split('name="category"', 1)[1].split("</select>", 1)[0]
    assert '<option value="alert">' in menu and '<option value="otp">' not in menu


def test_unsorted_mail_is_not_called_done(env):
    # nothing in Do now while emails still wait for the AI: not a success state yet
    r = env.client.get("/", params={"q": "Order"})
    do = r.text.split('data-col="do"', 1)[1].split("</section>", 1)[0]
    assert "1 still being sorted" in do and "You&#39;re clear" not in do
    conn = db.connect(env.path)
    conn.execute("UPDATE messages SET is_read = 1 WHERE id = ?", (env.ids["Contract needs signature"],))
    conn.commit()
    conn.close()
    assert '<h1 class="hero">Nothing to do yet</h1>' in env.client.get("/").text


def test_problem_banner_is_short_and_empty_inbox_has_one_primary(env, tmp_path):
    conn = db.connect(env.path)
    db.mark_synced(conn, env.shop, 0, error="LOGIN failed: bad password")
    conn.commit()
    conn.close()
    html = env.client.get("/").text
    banner = html.split('class="banner warn"', 1)[1].split("</form>", 1)[0]
    assert "<summary>How to fix</summary>" in banner
    assert '<code class="cmd">python -m app.cli set-password info@shop.example</code>' in banner
    empty = tmp_path / "empty.db"
    client = TestClient(create_app(conn_factory=lambda: db.connect(empty)))
    assert client.get("/").text.count("btn-primary") == 1  # the empty state's Sync now


def test_opening_in_pane_marks_read_but_plain_views_do_not(env):
    unread = [r["id"] for r in query(env, "SELECT id FROM messages WHERE is_read = 0")]
    mid = unread[0]
    env.client.get(f"/message/{mid}?partial=1")           # a refresh of the pane: no change
    env.client.get(f"/?open={mid}")                        # a full-page render: no change
    assert query(env, "SELECT is_read FROM messages WHERE id = ?", mid)[0]["is_read"] == 0
    r = env.client.get(f"/message/{mid}?partial=1&mark_read=1")  # the user opened it
    assert r.status_code == 200
    assert query(env, "SELECT is_read FROM messages WHERE id = ?", mid)[0]["is_read"] == 1
    assert "Mark unread" in r.text
