// Small enhancements on top of the server-rendered pages (everything works without JS):
// open emails in the side pane, post forms without a full reload, remember collapsed
// columns, and keep the unread "do now" count in the tab title.
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } },
  };

  // --- collapsed columns -------------------------------------------------------------
  function restoreColumns() {
    $$("details[data-key]").forEach((d) => {
      const saved = store.get("col:" + d.dataset.key);
      if (saved !== null) d.open = saved === "1";
    });
  }
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.dataset.key) store.set("col:" + d.dataset.key, d.open ? "1" : "0");
  }, true);

  // --- status messages ---------------------------------------------------------------
  let flashTimer;
  function flash(text, ok) {
    const box = $("#flash");
    if (!box) return;
    const p = document.createElement("p");
    p.className = "flash " + (ok ? "ok" : "err");
    p.setAttribute("role", "status");
    p.textContent = text;
    box.replaceChildren(p);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => box.replaceChildren(), ok ? 6000 : 12000);
  }
  if ($("#flash .flash")) flashTimer = setTimeout(() => $("#flash").replaceChildren(), 8000);

  // Re-render the page in place after an action, keeping the reading position.
  async function refresh() {
    const res = await fetch(location.href, { headers: { Accept: "text/html" } });
    if (!res.ok) return location.reload();
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const paneTop = $("#pane")?.scrollTop ?? 0;
    for (const id of ["filterbar", "status", "content"]) {
      const now = document.getElementById(id), next = doc.getElementById(id);
      if (now && next) now.replaceWith(document.adoptNode(next));
    }
    document.title = doc.title;
    const pane = $("#pane");
    if (pane) pane.scrollTop = paneTop;
    restoreColumns();
  }

  // --- side pane ---------------------------------------------------------------------
  function markActive(id) {
    $$(".card.active").forEach((c) => c.classList.remove("active"));
    if (id) $$(`.card[data-id="${CSS.escape(String(id))}"]`).forEach((c) => c.classList.add("active"));
  }

  async function openMessage(id, href, push = true) {
    const pane = $("#pane");
    if (!pane) { location.href = href; return; }
    const url = new URL(href, location.href);
    const next = encodeURIComponent(url.pathname + url.search);
    let res;
    try {
      res = await fetch(`/message/${encodeURIComponent(id)}?partial=1&next=${next}`);
    } catch { location.href = href; return; }
    if (!res.ok) { location.href = href; return; }
    pane.innerHTML = await res.text(); // rendered by our server, email text already escaped
    pane.scrollTop = 0;
    $("#layout")?.classList.add("with-pane");
    markActive(id);
    if (push) history.pushState(null, "", url);
  }

  function closePane(href, push = true) {
    const pane = $("#pane");
    if (!pane) return;
    pane.replaceChildren();
    $("#layout")?.classList.remove("with-pane");
    markActive(null);
    if (push && href) history.pushState(null, "", href);
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const open = e.target.closest("a[data-open]");
    if (open && $("#pane")) { e.preventDefault(); openMessage(open.dataset.open, open.href); return; }
    const close = e.target.closest("a[data-close]");
    if (close && $("#pane")) { e.preventDefault(); closePane(close.href); }
  });

  window.addEventListener("popstate", () => {
    if (!$("#pane")) return;
    const id = new URLSearchParams(location.search).get("open");
    if (id) openMessage(id, location.href, false);
    else closePane(null, false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.target.closest("input, select, textarea")) return;
    const close = $("#pane a[data-close]");
    if (close && $("#layout.with-pane")) closePane(close.href);
  });

  // --- forms: post with fetch, then refresh in place ----------------------------------
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (form.id === "filters") { // keep the URL short: leave out empty filters
      e.preventDefault();
      const params = new URLSearchParams(new FormData(form));
      for (const [key, value] of [...params]) if (!value) params.delete(key);
      const query = params.toString();
      location.href = form.getAttribute("action") + (query ? "?" + query : "");
      return;
    }
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-enhance")) return;
    e.preventDefault();
    const btn = e.submitter;
    const body = new URLSearchParams(new FormData(form));
    if (btn && btn.name) body.append(btn.name, btn.value);
    const label = btn && btn.dataset.busy ? btn.querySelector("span") : null;
    const oldText = label ? label.textContent : "";
    form.classList.add("busy");
    if (btn) btn.disabled = true;
    if (label) label.textContent = btn.dataset.busy;
    let ok = false;
    let msg = "Could not reach the dashboard server";
    try {
      const res = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      ok = res.ok && data.ok !== false;
      msg = data.message || (typeof data.detail === "string" ? data.detail : "") || (ok ? "Done" : `Failed (${res.status})`);
    } catch { /* keep the default message */ }
    form.classList.remove("busy");
    if (btn) btn.disabled = false;
    if (label) label.textContent = oldText;
    try { await refresh(); } catch { /* the action itself is done */ }
    flash(msg, ok);
  });

  // filters apply as soon as they change
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches && el.matches("[data-autosubmit]") && el.form) el.form.requestSubmit();
  });

  // --- unread "do now" count in the tab title ------------------------------------------
  async function pollStats() {
    try {
      const s = await (await fetch("/api/stats", { headers: { Accept: "application/json" } })).json();
      const base = document.title.replace(/^\(\d+\)\s*/, "");
      document.title = (s.unread_do ? `(${s.unread_do}) ` : "") + base;
    } catch { /* server not running */ }
  }
  setInterval(pollStats, 120000);

  restoreColumns();
})();
