// Enhancements on top of the server-rendered pages. Every action also works as a plain
// form post (POST-redirect-GET); this file only makes it faster: Gmail-style reading view,
// compose window / inline replies with Undo send, optimistic moves with undo, snackbars,
// keyboard shortcuts, sync states, live counts, display prefs.
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const media = (q) => window.matchMedia(q);
  const reduceMotion = media("(prefers-reduced-motion: reduce)");
  const finePointer = media("(hover: hover) and (pointer: fine)");
  const phone = media("(max-width: 767px)");
  const desktop = media("(min-width: 1280px)");
  const KEYS = ["do", "schedule", "quick", "later"];
  const LABELS = { do: "Do now", schedule: "Schedule", quick: "Quick reply", later: "Later" };
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, "\\$&"));

  // iOS Safari only shows :active press states when a touch listener exists.
  document.addEventListener("touchstart", () => {}, { passive: true });

  // --- motion: springs and drags (Apple's damping / response model) ------------------------
  // A spring moves a value toward its target from wherever it is now, keeping its speed, so a
  // motion can be grabbed or reversed mid-flight. response: seconds to arrive; damping 1 = no bounce.
  function spring(paint, { response = 0.4, damping = 1 } = {}) {
    const s = { value: 0, velocity: 0, target: 0 };
    let raf = 0, last = 0, onRest = null;
    const frame = (now) => {
      const dt = Math.min(0.064, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      const k = (2 * Math.PI / response) ** 2, c = 4 * Math.PI * damping / response;
      for (let t = 0; t < dt; t += 1 / 240) {
        const h = Math.min(1 / 240, dt - t);
        s.velocity += (-k * (s.value - s.target) - c * s.velocity) * h;
        s.value += s.velocity * h;
      }
      if (Math.abs(s.value - s.target) < 0.0005 && Math.abs(s.velocity) < 0.02) {
        s.value = s.target; s.velocity = 0; raf = 0;
        paint(s.value);
        const done = onRest; onRest = null; done?.();
        return;
      }
      paint(s.value);
      raf = requestAnimationFrame(frame);
    };
    // animate to `target`; `velocity` (units per second) hands over the finger's speed
    s.to = (target, { velocity, rest = null } = {}) => {
      s.target = target;
      if (velocity !== undefined && Number.isFinite(velocity)) s.velocity = velocity;
      onRest = rest; // only the latest motion's callback runs: a reversed motion never "finishes"
      if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    };
    // jump there now (a finger is holding it, or motion is reduced)
    s.set = (value) => {
      cancelAnimationFrame(raf); raf = 0; onRest = null;
      s.value = s.target = value; s.velocity = 0;
      paint(value);
    };
    s.moving = () => raf !== 0;
    return s;
  }
  // where a flick would come to rest (Apple's scroll deceleration), in px
  const projection = (v, rate = 0.998) => (v / 1000) * rate / (1 - rate);
  // past an edge things follow less and less, never stop dead
  const rubberband = (over, size, c = 0.55) => (over * size * c) / (size + c * Math.abs(over));
  // Follow a finger along one axis: ~10px of slack before committing (so taps and scrolls win),
  // then 1:1, and the speed at release. A drag never also counts as a tap on what it started on.
  let dragEndedAt = -Infinity;
  function drag({ axis = "x", grab, start, move, end }) {
    document.addEventListener("pointerdown", (e) => {
      // fingers and pens only (a mouse selects text), and never while the page is pinch-zoomed
      if (!e.isPrimary || e.button !== 0 || e.pointerType === "mouse" || zoomed()) return;
      const el = grab(e);
      if (!el) return;
      const x0 = e.clientX, y0 = e.clientY;
      let live = false;
      const samples = [];
      const delta = (ev) => (axis === "x" ? ev.clientX - x0 : ev.clientY - y0);
      const onMove = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const d = delta(ev), other = axis === "x" ? ev.clientY - y0 : ev.clientX - x0;
        if (!live) {
          if (Math.abs(d) < 10 && Math.abs(other) < 10) return;
          if (Math.abs(d) <= Math.abs(other) || start(d, el) === false) { stop(); return; } // scrolling won
          live = true;
          el.classList.add("dragging");
          try { el.setPointerCapture(e.pointerId); } catch { /* the pointer already left */ }
        }
        samples.push([ev.timeStamp, d]);
        if (samples.length > 8) samples.shift();
        move(d, el);
      };
      const onUp = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        stop();
        if (!live) return;
        el.classList.remove("dragging");
        dragEndedAt = performance.now();
        const lastS = samples[samples.length - 1] || [ev.timeStamp, delta(ev)];
        const firstS = samples.find((s) => lastS[0] - s[0] <= 80) || lastS; // speed over the last 80ms
        const held = ev.timeStamp - lastS[0] > 80; // the finger stopped before letting go
        const v = !held && lastS[0] > firstS[0] ? (lastS[1] - firstS[1]) / ((lastS[0] - firstS[0]) / 1000) : 0;
        end(lastS[1], ev.type === "pointercancel" ? 0 : v, el);
      };
      function stop() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      }
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }
  document.addEventListener("click", (e) => {
    if (performance.now() - dragEndedAt < 350) { e.preventDefault(); e.stopPropagation(); dragEndedAt = -Infinity; }
  }, true);
  // only the click a drag itself produces is cancelled: a new press is a real tap
  document.addEventListener("pointerdown", () => { dragEndedAt = -Infinity; }, true);
  // pinch-zoomed: sideways pans move the zoomed page, so the swipe gestures stand aside
  const zoomed = () => !!window.visualViewport && window.visualViewport.scale > 1.01;
  window.visualViewport?.addEventListener("resize", () => root.classList.toggle("zoomed", zoomed()));
  // run a DOM change as a morph (minimise / maximise, theme) where the browser can
  function morph(update) {
    if (document.startViewTransition && !reduceMotion.matches) {
      try { return localTransition(update); } catch { root.classList.remove("vt-local"); /* fall through */ }
    }
    update();
    return null;
  }
  // a view transition inside this page: only the root cross-fades (plus any one-off names)
  function localTransition(update) {
    root.classList.add("vt-local");
    const vt = document.startViewTransition(update);
    vt.finished.finally(() => root.classList.remove("vt-local")).catch(() => {});
    return vt;
  }

  // --- display preferences (⋯ menu and shortcut sheet switches) -------------------------
  const SWITCHES = {
    density: { get: () => root.dataset.density === "compact",
      set: (on) => { if (on) root.dataset.density = "compact"; else delete root.dataset.density; store.set("pref:density", on ? "compact" : "comfortable"); } },
    glass: { get: () => root.dataset.glass === "off",
      set: (on) => { if (on) root.dataset.glass = "off"; else delete root.dataset.glass; store.set("pref:glass", on ? "off" : "on"); } },
    advance: { get: () => root.dataset.advance !== "off",
      set: (on) => { if (on) delete root.dataset.advance; else root.dataset.advance = "off"; store.set("pref:advance", on ? "on" : "off"); } },
    keys: { get: () => root.dataset.keys !== "off",
      set: (on) => { if (on) delete root.dataset.keys; else root.dataset.keys = "off"; store.set("pref:keys", on ? "on" : "off"); } },
    split: { get: () => root.dataset.split === "on",
      set: (on) => { if (on) root.dataset.split = "on"; else delete root.dataset.split; store.set("pref:split", on ? "on" : "off"); } },
  };
  // Appearance: Auto follows macOS; Light / Dark stick (saved, applied before paint by prefs.js)
  const currentTheme = () => (root.dataset.theme === "light" || root.dataset.theme === "dark" ? root.dataset.theme : "auto");
  function setTheme(theme) {
    if (theme === "auto") delete root.dataset.theme; else root.dataset.theme = theme;
    store.set("pref:theme", theme);
    $$('meta[name="theme-color"]').forEach((m) => {
      const dark = theme === "auto" ? (m.getAttribute("media") || "").includes("dark") : theme === "dark";
      m.setAttribute("content", dark ? "#0e0f0c" : "#e8ebe6");
    });
    $('meta[name="color-scheme"]')?.setAttribute("content", theme === "auto" ? "light dark" : theme);
  }
  document.addEventListener("change", (e) => {
    if (e.target.matches?.('input[name="theme"]')) { const v = e.target.value; morph(() => setTheme(v)); } // a soft cross-fade, no flash
  });
  function syncSwitches() {
    $$("[data-prefs]").forEach((el) => { el.hidden = false; });
    $$('input[name="theme"]').forEach((i) => { i.checked = i.value === currentTheme(); });
    $$("[data-pref]").forEach((b) => {
      const s = SWITCHES[b.dataset.pref];
      if (s) b.setAttribute("aria-checked", String(s.get()));
    });
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pref]");
    if (!b || !SWITCHES[b.dataset.pref]) return;
    const s = SWITCHES[b.dataset.pref];
    s.set(!s.get());
    syncSwitches();
  });

  // --- remembered column / strip open state -----------------------------------------------
  function restoreColumns() {
    $$("details[data-key]").forEach((d) => {
      const saved = store.get("col:" + d.dataset.key);
      if (saved !== null) d.open = saved === "1";
    });
  }
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.dataset.key) store.set("col:" + d.dataset.key, d.open && !d.classList.contains("shutting") ? "1" : "0");
  }, true);

  // --- menus: light dismiss, one at a time, exit the way they came in ----------------------
  function closeMenu(d, focusSummary = false) {
    if (!d || !d.open || d.classList.contains("closing")) return;
    const done = () => { d.classList.remove("closing"); d.open = false; };
    if (reduceMotion.matches) done();
    else { d.classList.add("closing"); setTimeout(done, 160); }
    if (focusSummary) $("summary", d)?.focus();
  }
  document.addEventListener("click", (e) => {
    for (const d of $$("details.menu-wrap[open]")) {
      if (!d.contains(e.target)) closeMenu(d);
      else if (e.target.closest(".menu a, .menu button:not([role='switch'])")) closeMenu(d);
    }
  }, true);
  document.addEventListener("click", (e) => {
    const s = e.target.closest("details.menu-wrap > summary");
    if (s && s.parentElement.open) { e.preventDefault(); closeMenu(s.parentElement); }
  });
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.matches(".menu-wrap") && d.open) {
      $$("details.menu-wrap[open]").forEach((o) => { if (o !== d) closeMenu(o); });
      d._y = window.scrollY;
    }
  }, true);

  // --- disclosures (Categories, panels, quoted text, Sent rows): grow and shrink on a spring --
  const SPRING = (() => {
    const css = getComputedStyle(root).getPropertyValue("--spring").trim();
    return css && window.CSS?.supports?.("transition-timing-function", css) ? css : "cubic-bezier(0.32, 0.72, 0, 1)";
  })();
  function toggleDetails(d) {
    const opening = !d.open || d.classList.contains("shutting");
    if (d.dataset.key) store.set("col:" + d.dataset.key, opening ? "1" : "0");
    const from = d.getBoundingClientRect().height; // mid-animation: from where it is now
    d._anim?.cancel();
    d.classList.remove("shutting");
    d.open = true;
    const full = d.getBoundingClientRect().height;
    d.open = false;
    const shut = d.getBoundingClientRect().height;
    d.open = true;
    if (!opening) d.classList.add("shutting");
    const to = opening ? full : shut;
    d.style.overflow = "hidden";
    let anim;
    try {
      anim = d.animate([{ height: from + "px" }, { height: to + "px" }], { duration: opening ? 480 : 360, easing: SPRING });
    } catch {
      d.style.overflow = ""; d.classList.remove("shutting"); d.open = opening;
      return;
    }
    d._anim = anim;
    anim.onfinish = () => {
      d._anim = null;
      d.style.overflow = "";
      if (d.classList.contains("shutting")) { d.classList.remove("shutting"); d.open = false; }
    };
  }
  document.addEventListener("click", (e) => {
    const s = e.target.closest("details > summary");
    const d = s?.parentElement;
    if (!d || e.defaultPrevented || reduceMotion.matches || d.matches(".menu-wrap") || !d.animate) return;
    if (e.target.closest("a, button, input, select, textarea, label") && e.target.closest("a, button, input, select, textarea, label") !== s) return;
    e.preventDefault();
    toggleDetails(d);
  });

  // --- page changes: the tab underline glides only when it's really in view ---------------
  // (a named element is drawn above everything during the transition, so one hidden under the
  // sticky bar, behind an open email or the menu would float over them)
  function nameTabIndOnlyInView() {
    const ind = $(".tab[aria-current] .tab-ind");
    if (!ind) return;
    const r = ind.getBoundingClientRect();
    const barBottom = $(".top")?.getBoundingClientRect().bottom ?? 0;
    const hidden = !r.width || r.top < barBottom || r.bottom > innerHeight || paneOpen() || drawerOpen() || !!$(".compose-window:not(.minimized):not(.leaving)");
    ind.style.viewTransitionName = hidden ? "none" : "";
  }
  window.addEventListener("pageswap", (e) => { if (e.viewTransition) nameTabIndOnlyInView(); });
  window.addEventListener("pagereveal", (e) => { if (e.viewTransition) nameTabIndOnlyInView(); });

  // --- shortcut sheet (popover; works without JS in Safari 17+) ----------------------------
  const sheet = () => $("#keys");
  function sheetOpen() {
    const k = sheet();
    try { return !!k && k.matches(":popover-open"); } catch { return false; }
  }
  function toggleSheet() {
    const k = sheet();
    if (!k || typeof k.showPopover !== "function") return;
    try { if (sheetOpen()) k.hidePopover(); else k.showPopover(); } catch { /* already toggled */ }
  }
  let sheetReturn = null;
  sheet()?.addEventListener("beforetoggle", (e) => {
    if (e.newState !== "open") return;
    const a = document.activeElement;
    const menu = a?.closest?.(".menu-wrap");
    // opened from (⋯): that menu is about to close, so come back to its button
    sheetReturn = menu ? $("summary", menu) : (a && a !== document.body ? a : null);
  });
  sheet()?.addEventListener("toggle", (e) => {
    const k = sheet();
    if (e.newState === "open") { $(".sheet-head .icon-btn", k)?.focus({ preventScroll: true }); return; }
    const a = document.activeElement;
    if ((!a || a === document.body || k.contains(a)) && sheetReturn?.isConnected) sheetReturn.focus({ preventScroll: true });
    sheetReturn = null;
  });

  // --- toasts: one at a time, timers pause on hover/focus, errors stay until closed -------
  let pendingMoment = null;
  function dismiss(p) {
    if (!p || p.classList.contains("leaving")) return;
    clearTimeout(p._timer);
    p.classList.add("leaving");
    setTimeout(() => p.remove(), reduceMotion.matches ? 150 : 220);
    if (pendingMoment && !$("#flash .flash:not(.leaving)")) {
      const m = pendingMoment;
      pendingMoment = null;
      setTimeout(() => toast(m), 240);
    }
  }
  function arm(p, ms) {
    p._remain = ms;
    const pause = () => {
      if (!p._remain || p._paused) return;
      p._paused = true;
      clearTimeout(p._timer);
      p._remain = Math.max(1500, p._remain - (Date.now() - p._t0));
    };
    const resume = () => {
      if (!p._remain || p.matches(":hover") || p.contains(document.activeElement)) return;
      p._paused = false;
      p._t0 = Date.now();
      clearTimeout(p._timer);
      p._timer = setTimeout(() => dismiss(p), p._remain);
    };
    p.addEventListener("pointerenter", pause);
    p.addEventListener("focusin", pause);
    p.addEventListener("pointerleave", () => setTimeout(resume, 0));
    p.addEventListener("focusout", () => setTimeout(resume, 0));
    p._t0 = Date.now();
    p._timer = setTimeout(() => dismiss(p), ms);
  }
  function toast(text, { kind = "ok", actions = [], timeout, keep = false } = {}) {
    const box = $("#flash");
    if (!box) return null;
    // a "Sending… Undo" snackbar stays until its time is up: other notes show next to it
    $$(".flash", box).forEach((old) => { if (!old.classList.contains("leaving") && !old.dataset.keep) dismiss(old); });
    const p = document.createElement("p");
    p.className = "flash " + kind;
    p.setAttribute("role", kind === "err" ? "alert" : "status");
    const glyph = document.createElement("span");
    glyph.className = "flash-glyph";
    glyph.setAttribute("aria-hidden", "true");
    const icon = kind === "err" ? "#i-q-do" : kind === "info" ? "#i-sync" : "#i-check";
    glyph.innerHTML = `<svg class="ic" aria-hidden="true"><use href="${icon}"/></svg>`;
    const msg = document.createElement("span");
    msg.className = "flash-msg";
    msg.textContent = text;
    p.append(glyph, msg);
    for (const a of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "flash-btn";
      if (a.label === "Undo") b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-undo"/></svg>';
      b.append(a.label);
      if (a.label === "Undo" && a.key !== false) b.title = "Undo (z)";
      b.addEventListener("click", () => { if (p.classList.contains("leaving")) return; dismiss(p); a.run(); });
      p.append(b);
    }
    if (kind === "err") {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "flash-x";
      x.setAttribute("aria-label", "Dismiss");
      x.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';
      x.addEventListener("click", () => dismiss(p));
      p.append(x);
    }
    if (keep) p.dataset.keep = "1";
    box.append(p);
    const ms = timeout ?? (kind === "err" ? 0 : actions.length ? 8000 : 6000);
    if (ms) arm(p, ms);
    return p;
  }
  // a calm "moment" toast never replaces one that still offers Undo
  function moment(text) {
    if ($("#flash .flash:not(.leaving) .flash-btn")) pendingMoment = text;
    else toast(text);
  }
  // server-rendered flash (no-JS path): close button, auto-hide for success
  (() => {
    const p = $("#flash .flash");
    if (!p) return;
    $(".flash-x", p)?.addEventListener("click", (e) => { e.preventDefault(); dismiss(p); });
    if (p.classList.contains("ok")) arm(p, 8000);
  })();

  // --- undo stack (z) --------------------------------------------------------------------
  const undoStack = [];
  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > 5) undoStack.shift();
    return entry;
  }
  async function runUndo(entry) {
    const e = entry || undoStack[undoStack.length - 1];
    if (!e) { toast("Nothing to undo", { kind: "info" }); return; }
    const i = undoStack.indexOf(e);
    if (i >= 0) undoStack.splice(i, 1);
    const r = await e.run();
    if (r && r.ok === false) { toast(r.message || "Could not undo", { kind: "err" }); return; }
    try { await refresh(); } catch { /* the undo itself is done */ }
    toast("Undone");
    pollStats();
  }

  // --- network helpers ---------------------------------------------------------------------
  // signed out (session expired or logged out elsewhere): go to the login page, then come back
  function toLogin() {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
  }

  async function post(url, data) {
    pageCache.clear(); // remembered tabs would show the email before this change
    const body = data instanceof URLSearchParams ? data : new URLSearchParams(data);
    try {
      const res = await fetch(url, { method: "POST", body, headers: { Accept: "application/json" } });
      if (res.status === 401) { toLogin(); return { ok: false, status: 401, message: "Please sign in again", data: {} }; }
      const json = await res.json().catch(() => ({}));
      const ok = res.ok && json.ok !== false;
      const message = json.message || (typeof json.detail === "string" ? json.detail : "") || (ok ? "Done" : `Failed (${res.status})`);
      return { ok, status: res.status, message, data: json };
    } catch {
      return { ok: false, status: 0, message: "Could not reach the dashboard server", data: {} };
    }
  }
  function formBody(form, btn) {
    const body = new URLSearchParams(new FormData(form));
    if (btn && btn.name) body.append(btn.name, btn.value);
    return body;
  }

  // --- refresh: re-render #sidebar and #content in place, keep reading position ----------
  const lastHTML = {};
  let refreshChain = Promise.resolve();
  function refresh(opts = {}) {
    refreshChain = refreshChain.catch(() => {}).then(() => doRefresh(opts));
    return refreshChain;
  }
  function captureState() {
    const a = document.activeElement;
    const card = a && a.closest ? a.closest(".card") : null;
    return {
      typing: !!(a && a.closest?.("form[data-compose]")),
      paneTop: $("#pane")?.scrollTop ?? 0,
      focusCard: card ? card.dataset.id : null,
      focusId: !card && a && a.id && a !== document.body ? a.id : null,
      focusInPane: !!(a && $("#pane")?.contains(a)),
      hadFocus: !!(a && a !== document.body),
      navHref: a?.matches?.("a[href]") ? a.getAttribute("href") : null,
      more: $$("section.col").filter((c) => $(".more-cards[open]:not(.shutting)", c)).map((c) => c.dataset.col),
    };
  }
  function restoreState(s, focusSubject) {
    restoreColumns();
    for (const key of s.more) {
      const d = $(`section.col[data-col="${esc(key)}"] .more-cards`);
      if (d) d.open = true;
    }
    const pane = $("#pane");
    if (pane) pane.scrollTop = s.paneTop;
    if (s.typing) return; // a reply being written keeps its focus (restored in doRefresh)
    if (focusSubject || (s.focusInPane && (!document.activeElement || document.activeElement === document.body))) {
      const subj = $("#pane .detail-subject") || $(".detail-subject");
      if (subj) { subj.focus({ preventScroll: true }); return; }
    }
    if (s.focusCard) $(`.card[data-id="${esc(s.focusCard)}"] .card-link`)?.focus({ preventScroll: true });
    else if (s.focusId) document.getElementById(s.focusId)?.focus({ preventScroll: true });
    // the focused card left the view (moved out of a filter, or nothing left): never drop to <body>
    if (s.hadFocus && (!document.activeElement || document.activeElement === document.body)) {
      const next = visibleCards()[0]?.querySelector(".card-link") || $("#content .empty-state .btn, #content .done-state .btn");
      next?.focus({ preventScroll: true });
    }
  }
  // `nav`: a tab, filter or page was chosen (show it from the top); `html`: the page, already
  // on its way (prefetched on touch); `seq`: skip it if a newer tap came in meanwhile
  async function doRefresh({ moved = null, focusSubject = false, swapPane = false, nav = false, html = null, seq = 0 } = {}) {
    let text;
    try { text = await (html || loadPage(location.pathname + location.search)); } catch (err) {
      if (err?.message === "login") { toLogin(); return false; }
      throw err;
    }
    if (seq && seq !== navSeq) return false;
    shownKey = pageKey();
    const doc = new DOMParser().parseFromString(text, "text/html");
    document.title = doc.title;
    const swaps = [];
    for (const id of ["sidebar", "content"]) {
      const now = document.getElementById(id);
      const next = doc.getElementById(id);
      if (!now || !next) continue;
      const html = next.innerHTML;
      if (lastHTML[id] === html) continue;
      lastHTML[id] = html;
      swaps.push([now, next]);
    }
    if (!swaps.length) return false;
    const state = captureState();
    // the tab underline may be gliding to its tab: the new one carries on from there
    const flying = nav && performance.now() < glideUntil ? $(".tab[aria-current] .tab-ind")?.getBoundingClientRect() : null;
    const apply = () => {
      // a reply being written in the pane survives the re-render (same email still open)
      const keepPane = $("#pane [data-compose]:not(.leaving)") ? $("#pane") : null;
      const drawerOpen = $("#sidebar")?.classList.contains("open");
      const active = document.activeElement;
      const sel = active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
      const winY = window.scrollY;
      for (const [now, next] of swaps) now.replaceWith(document.adoptNode(next));
      const newPane = $("#pane");
      if (keepPane && newPane && newPane !== keepPane && newPane.querySelector(".detail")?.dataset.message === keepPane.querySelector(".detail")?.dataset.message) {
        newPane.replaceWith(keepPane);
        if (keepPane.contains(active)) {
          active.focus({ preventScroll: true });
          if (sel) { try { active.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
          window.scrollTo({ top: winY });
        }
      }
      if (drawerOpen) { $("#sidebar")?.classList.add("open"); if (drawerSpring.moving()) paintDrawer(drawerSpring.value); }
      if (nav) {
        window.scrollTo({ top: 0 });
        if (flying) glideTabInd(flying, glideUntil - performance.now());
        if (!reduceMotion.matches) $("#board")?.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180, easing: "linear" });
        // keep focus on what was pressed (its copy in the new page), never drop to <body>
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected) {
          const same = state.navHref && $$("a[href]").find((x) => x.getAttribute("href") === state.navHref);
          (same || $(".tab[aria-current]"))?.focus({ preventScroll: true });
        }
        return;
      }
      restoreState(state, focusSubject);
      if (moved) { const c = cardEl(moved); if (c) c.style.viewTransitionName = "moved-card"; }
      if (swapPane) { const pane = $("#pane"); pane?.classList.add("swap"); setTimeout(() => pane?.classList.remove("swap"), 200); }
    };
    const old = moved ? cardEl(moved) : null;
    if (old && document.startViewTransition && !reduceMotion.matches && old.getClientRects().length) {
      old.style.viewTransitionName = "moved-card";
      const vt = localTransition(apply);
      try { await vt.updateCallbackDone; } catch { /* the DOM is updated either way */ }
      vt.finished.finally(() => { const c = cardEl(moved); if (c) c.style.viewTransitionName = ""; }).catch(() => {});
    } else {
      apply();
      if (moved) { const c = cardEl(moved); if (c) c.style.viewTransitionName = ""; }
    }
    afterRender();
    return true;
  }
  // --- tabs, filters, views and pages swap in place (no page reload) ------------------------
  // The page starts loading when a finger or the mouse goes down on the link (a tap takes
  // ~100ms more to become a click), and a page seen in the last half minute shows at once
  // while a fresh copy is fetched behind it.
  const pageCache = new Map(); // "/?tab=later" -> { at, text: Promise<string> }
  const SHOW_CACHED_MS = 120000; // shown at once, then refreshed behind it (anything you change clears it)
  let navSeq = 0, shownKey = "", glideUntil = 0, navWaitTimer = 0;
  const urlKey = (href) => { const u = new URL(href, location.href); return u.pathname + u.search; };
  function pageKey(href = location.href) {
    const u = new URL(href, location.href);
    u.searchParams.delete("open");
    return u.pathname + "?" + [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map((kv) => kv.join("=")).join("&");
  }
  function loadPage(key) {
    return fetch(key, { headers: { Accept: "text/html" }, cache: "no-store" }).then((res) => {
      if (res.status === 401 || (res.redirected && new URL(res.url).pathname === "/login")) throw new Error("login");
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
  }
  function prefetch(href, maxAge = 15000) {
    const key = urlKey(href);
    const hit = pageCache.get(key);
    if (hit && performance.now() - hit.at < maxAge) return hit.text;
    const text = loadPage(key);
    text.catch(() => { if (pageCache.get(key)?.text === text) pageCache.delete(key); });
    pageCache.set(key, { at: performance.now(), text });
    if (pageCache.size > 12) pageCache.delete(pageCache.keys().next().value);
    return text;
  }
  // links that only change what the inbox shows (tab, filter, view, page)
  function inPlace(a) {
    if (!a || !$("#board") || a.target || a.hasAttribute("download") || a.hasAttribute("data-open")
        || a.matches("[data-compose-new], [data-compose-draft], [data-reply], [data-close], [data-drawer]")) return false;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname !== "/" || url.searchParams.has("open")) return false;
    if (url.hash && url.search === location.search) return false; // a jump within the page (#col-…)
    return true;
  }
  function glideTabInd(from, ms = 400) {
    const ind = $(".tab[aria-current] .tab-ind");
    if (!ind || !from?.width || reduceMotion.matches || !ind.animate) return;
    const to = ind.getBoundingClientRect();
    if (!to.width) return;
    glideUntil = performance.now() + ms;
    ind.animate([
      { transform: `translateX(${from.left - to.left}px) scaleX(${from.width / to.width})`, transformOrigin: "left center" },
      { transform: "none", transformOrigin: "left center" },
    ], { duration: Math.max(120, ms), easing: SPRING });
  }
  // the tapped tab shows as chosen straight away, before the list arrives
  function markChosen(a) {
    const tab = a.closest(".tab");
    if (!tab || tab.getAttribute("aria-current") === "page") return;
    const from = $(".tab[aria-current] .tab-ind")?.getBoundingClientRect();
    $$(".tab[aria-current]").forEach((t) => t.removeAttribute("aria-current"));
    tab.setAttribute("aria-current", "page");
    glideTabInd(from);
  }
  async function navigate(href, { push = true, from = null } = {}) {
    const key = urlKey(href);
    const seq = ++navSeq;
    $$("form[data-compose]").forEach(saveDraft);
    if (push) history.pushState(null, "", key);
    if (from) markChosen(from);
    clearTimeout(navWaitTimer);
    navWaitTimer = setTimeout(() => { if (seq === navSeq) root.classList.add("nav-wait"); }, 150); // only if it's slow
    const seen = pageCache.get(key);
    const fresh = seen && performance.now() - seen.at < SHOW_CACHED_MS;
    try {
      await refresh({ nav: true, html: prefetch(key, SHOW_CACHED_MS), seq });
      // shown from the half-minute cache: fetch it again and quietly update anything that changed
      if (fresh && seq === navSeq) { pageCache.delete(key); refresh({ html: prefetch(key), seq }).catch(() => {}); }
    } catch {
      if (seq === navSeq) location.href = key; // offline or an error: a normal page load explains it
    } finally {
      if (seq === navSeq) { clearTimeout(navWaitTimer); root.classList.remove("nav-wait"); }
    }
  }
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    if (!inPlace(a)) return;
    e.preventDefault();
    navigate(a.href, { from: a });
  });
  // start loading on press; on desktop, also after a short hover
  document.addEventListener("pointerdown", (e) => {
    const a = e.target.closest?.("a[href]");
    if (inPlace(a)) prefetch(a.href);
  }, { passive: true, capture: true });
  let hoverTimer = 0;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(hoverTimer);
    const a = e.target.closest?.("a[href]");
    if (inPlace(a)) hoverTimer = setTimeout(() => prefetch(a.href), 80);
  }, { passive: true });
  // the inbox swaps in place; anywhere else (Sent, Rules) it's a normal page load
  function go(href) {
    const url = new URL(href, location.href);
    if ($("#board") && url.origin === location.origin && url.pathname === "/") navigate(url.href);
    else location.href = href;
  }

  function afterRender() {
    syncSwitches();
    setupNav();
    updateDock();
    syncModal();
    baseline.sorted = null;
    hidePill();
  }
  // phone: the email sheet covers the page, so hide the page from focus and VoiceOver
  function syncModal() {
    const win = $("#compose-dock .compose-window:not(.minimized):not(.leaving)");
    const covered = phone.matches && (paneOpen() || !!win); // full-screen email or compose
    const drawer = drawerOpen();
    for (const el of [$(".skip"), $(".top"), $(".fab")]) if (el) el.inert = covered || drawer;
    const side = $("#sidebar");
    if (side) side.inert = covered && !drawer;
    if ($("#board")) $("#board").inert = covered || drawer;
    const pane = $("#pane");
    if (pane) pane.inert = (phone.matches && !!win) || drawer;
  }
  phone.addEventListener?.("change", syncModal);

  // --- cards, pane, navigation -----------------------------------------------------------
  const cardEl = (id) => (id == null ? null : $(`#board .card[data-id="${esc(id)}"]`));
  const paneOpen = () => !!$("#layout.with-pane:not(.pane-out)");
  const openId = () => $("#pane .detail")?.dataset.message ?? null;
  const focusedCardId = () => document.activeElement?.closest?.(".card")?.dataset.id ?? null;
  function hrefFor(id) {
    const link = cardEl(id)?.querySelector(".card-link");
    if (link) return link.href;
    const u = new URL(location.href);
    u.searchParams.set("open", id);
    return u.href;
  }
  // phones: swipe the email to the right to go back to the list (anywhere on it, like iOS)
  let paneFrom = 1;
  const scrollsSideways = (el, stop) => {
    for (let n = el; n && n !== stop; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  drag({
    axis: "x",
    grab: (e) => {
      const pane = $("#pane");
      if (!pushes() || !paneOpen() || !pane?.contains(e.target)) return null;
      if (e.target.closest("input, textarea, select, [contenteditable], form[data-compose]")) return null;
      if (String(window.getSelection?.() || "") || scrollsSideways(e.target, pane)) return null;
      return pane;
    },
    start: (d) => {
      if (d <= 0) return false; // only to the right
      paneFrom = paneSpring.moving() ? paneSpring.value : 1;
      paneSpring.set(paneFrom);
    },
    move: (d) => paneSpring.set(Math.min(1, paneFrom - d / innerWidth)),
    end: (d, v) => {
      const at = Math.min(1, paneFrom - d / innerWidth);
      const vel = -v / innerWidth;
      if (at - projection(v) / innerWidth < 0.5) closePane(closeHref(), { velocity: vel });
      else paneSpring.to(1, { velocity: vel, rest: settlePane });
    },
  });
  function closeHref() {
    const c = $("#pane a[data-close]");
    if (c) return c.href;
    const u = new URL(location.href);
    u.searchParams.delete("open");
    return u.href;
  }
  // with the reading view covering the list (Gmail default), j/k still walk the list behind it
  const boardHidden = () => { const b = $("#board"); return !!b && !b.getClientRects().length; };
  function visibleCards() {
    const hidden = boardHidden();
    return $$("#board .card").filter((c) => !c.closest("details:not([open])") && (hidden || c.getClientRects().length));
  }
  function neighbourId(id) {
    const list = visibleCards();
    const i = list.findIndex((c) => c.dataset.id === String(id));
    if (i < 0) return null;
    const n = list[i + 1] || list[i - 1];
    return n ? n.dataset.id : null;
  }
  function markActive(id) {
    $$(".card.active").forEach((c) => c.classList.remove("active"));
    if (id != null) $$(`.card[data-id="${esc(id)}"]`).forEach((c) => c.classList.add("active"));
  }
  function setupNav() {
    $$("[data-nav]").forEach((n) => { n.hidden = false; });
  }

  let closeTimer = 0;
  // phones: the email slides in over the list like an iOS push (the list drifts left beneath
  // it) and slides back out on Back or when swiped to the right. 0 = list, 1 = email.
  const pushes = () => phone.matches && !reduceMotion.matches;
  const paneSpring = spring(paintPane, { response: 0.42 });
  function paintPane(q) {
    const pane = $("#pane");
    const board = $("#board");
    const moving = q > 0.0005 && q < 0.9995;
    if (pane) {
      pane.style.transform = moving || q <= 0 ? `translate3d(${((1 - q) * 100).toFixed(3)}%, 0, 0)` : "";
      pane.classList.toggle("moving", moving);
    }
    // the list drifts left beneath; its parts move, not #board, so the fixed matrix dock stays put
    for (const part of board ? $$(":scope > :not(.dock)", board) : []) {
      part.style.transform = moving ? `translate3d(${(-q * 28).toFixed(3)}%, 0, 0)` : "";
      part.classList.toggle("moving", moving);
    }
  }
  function settlePane() {
    const pane = $("#pane");
    if (pane) { pane.style.transform = ""; pane.classList.remove("moving"); }
    for (const part of $$("#board > :not(.dock)")) { part.style.transform = ""; part.classList.remove("moving"); }
  }
  async function openMessage(id, href, { push = true, focus = false } = {}) {
    const pane = $("#pane");
    const layout = $("#layout");
    if (!pane || !layout) { location.href = href; return; }
    const url = new URL(href, location.href);
    const next = encodeURIComponent(url.pathname + url.search);
    let html;
    try {
      // opening an email marks it read, like any mail app (⇧U marks it unread again)
      const res = await fetch(`/message/${encodeURIComponent(id)}?partial=1&mark_read=1&next=${next}`,
        { headers: { "X-Inbox-Open": "1" } });
      if (!res.ok) throw new Error(String(res.status));
      html = await res.text();
    } catch { location.href = href; return; }
    const wasOpen = layout.classList.contains("with-pane") && !layout.classList.contains("pane-out");
    if (!wasOpen) listY = window.scrollY;
    clearTimeout(closeTimer);
    layout.classList.remove("pane-out");
    pane.innerHTML = html; // rendered by our server; email text is already escaped
    pane.scrollTop = 0;
    if (boardHidden()) window.scrollTo({ top: 0 });
    lastHTML.content = null; // the DOM no longer matches the last full render
    if (wasOpen) {
      pane.classList.remove("swap");
      void pane.offsetWidth;
      pane.classList.add("swap");
      setTimeout(() => pane.classList.remove("swap"), 200);
    } else if (pushes()) {
      // from off-screen, or from wherever a closing email was caught
      if (!layout.classList.contains("with-pane")) paneSpring.set(0);
      layout.classList.add("with-pane");
      paneSpring.to(1, { rest: settlePane });
    } else {
      layout.classList.add("pane-enter", "with-pane");
      setTimeout(() => layout.classList.remove("pane-enter"), 600);
    }
    markActive(id);
    const wasUnread = showAsRead(id);
    setupNav();
    if (push) history.pushState(null, "", url);
    syncModal();
    // phone: the sheet covers the board, so a tap (or VoiceOver double-tap) moves focus in too
    if (focus || phone.matches) $(".detail-subject", pane)?.focus({ preventScroll: true });
    if (wasUnread) pollStats(); // title, headline and dock; the board itself is left alone
  }

  // The server marked it read when the pane loaded. Like any mail app, the card only loses its
  // unread styling and stays exactly where it is: no re-render, no jump, even under "Unread".
  function showAsRead(id) {
    const card = $(`.card[data-id="${esc(id)}"]`);
    if (!card || card.dataset.read === "1") return false;
    card.classList.remove("unread");
    card.dataset.read = "1";
    const rowForm = $(".row-act", card);
    if (rowForm) {
      const v = $("[name=is_read]", rowForm);
      if (v) v.value = "0";
      const b = $("button", rowForm);
      if (b) {
        b.title = "Mark as unread";
        b.setAttribute("aria-label", b.getAttribute("aria-label").replace(/^Mark as read/, "Mark as unread"));
        $("use", b)?.setAttribute("href", "#i-unread");
      }
    }
    $(".sender .sr-only", card)?.remove();
    lastHTML.content = null; // the next real refresh must redraw
    const count = card.closest(".col")?.querySelector(".col-head .count");
    if (count) {
      const shown = count.querySelector('[aria-hidden="true"]');
      const b = shown?.querySelector("b");
      const n = b ? parseInt(b.textContent, 10) - 1 : 0;
      const total = shown ? shown.textContent.split("·").pop().trim() : "";
      if (shown) shown.innerHTML = (n > 0 ? `<b>${n} new</b> · ` : "") + total;
      const sr = count.querySelector(".sr-only");
      if (sr) sr.textContent = `${Math.max(n, 0)} unread of ${total}`;
    }
    const dec = (n) => {
      if (!n?.firstChild) return;
      const left = parseInt(n.firstChild.textContent, 10) - 1;
      if (left > 0) n.firstChild.textContent = String(left); else n.remove();
    };
    dec($('.sidebar .nav-item[href="/"] .n'));
    const email = card.dataset.account;
    if (email) dec($$(".sidebar .acct-item").find((a) => a.dataset.email === email)?.querySelector(".n"));
    dec($(".tabs .tab[aria-current] .tab-new[data-new]"));
    return true;
  }

  let listY = 0;
  function closePane(href, { push = true, focusBack = true, velocity, instant = false } = {}) {
    const pane = $("#pane");
    const layout = $("#layout");
    if (push && href) history.pushState(null, "", href);
    if (!pane || !layout || !layout.classList.contains("with-pane")) return;
    const id = openId();
    lastHTML.content = null;
    const covering = boardHidden();
    layout.classList.add("pane-out");
    clearTimeout(closeTimer);
    const done = () => {
      layout.classList.remove("with-pane", "pane-out");
      pane.replaceChildren();
      settlePane();
      syncModal();
    };
    if (covering) {
      // the list comes back where you left it, easing in
      if (!reduceMotion.matches) { layout.classList.add("board-enter"); setTimeout(() => layout.classList.remove("board-enter"), 600); }
      done();
      window.scrollTo({ top: listY });
    } else if (instant) {
      paneSpring.set(0);
      done();
    } else if (pushes()) {
      // opened with the page (no spring ran yet): it starts from fully open; a swipe hands over its speed
      if (!paneSpring.moving() && velocity === undefined) paneSpring.set(1);
      paneSpring.to(0, { velocity, rest: done });
    } else closeTimer = setTimeout(done, reduceMotion.matches ? 150 : 220);
    syncModal(); // before focusBack: an inert card link can't take focus
    markActive(null);
    if (focusBack && id) {
      const link = cardEl(id)?.querySelector(".card-link");
      if (link) { link.focus({ preventScroll: true }); link.closest(".card").scrollIntoView({ block: "nearest" }); }
    }
  }

  function stepEmail(dir, { moveFocus = true } = {}) {
    const list = visibleCards();
    if (!list.length) return;
    const cur = openId() ?? focusedCardId();
    let i = list.findIndex((c) => c.dataset.id === cur);
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir));
    const card = list[i];
    const link = $(".card-link", card);
    const behavior = reduceMotion.matches ? "auto" : "smooth";
    if (paneOpen()) {
      const inPane = !!$("#pane")?.contains(document.activeElement);
      if (card.dataset.id !== openId()) openMessage(card.dataset.id, link.href, { focus: inPane || boardHidden() });
      if (!phone.matches) card.scrollIntoView({ block: "nearest", behavior });
      if (moveFocus && !phone.matches && !$("#pane")?.contains(document.activeElement)) link.focus({ preventScroll: true });
    } else {
      link.focus({ preventScroll: true });
      card.scrollIntoView({ block: "nearest", behavior });
    }
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const open = e.target.closest("a[data-open]");
    if (open && $("#pane")) {
      e.preventDefault();
      openMessage(open.dataset.open, open.href, { focus: e.detail === 0 });
      return;
    }
    const close = e.target.closest("a[data-close]");
    if (close && $("#pane")) { e.preventDefault(); closePane(close.href); return; }
    const step = e.target.closest("[data-step]");
    if (step) { e.preventDefault(); stepEmail(Number(step.dataset.step), { moveFocus: false }); return; }
    const dockItem = e.target.closest(".dock-item");
    if (dockItem) {
      const d = $(`#col-${esc(dockItem.dataset.col)} > details`);
      if (d && !d.open) d.open = true;
      setDockCurrent(dockItem.dataset.col);
      dockHold = performance.now() + 600;
      return;
    }
    if (e.target.closest("#new-pill")) {
      hidePill();
      refresh().catch(() => location.reload());
    }
  });

  window.addEventListener("popstate", (e) => {
    if (!$("#pane")) return;
    if (shownKey && pageKey() !== shownKey) { navigate(location.href, { push: false }); return; } // another tab or filter
    const id = new URLSearchParams(location.search).get("open");
    if (id) { if (id !== openId() || !paneOpen()) openMessage(id, location.href, { push: false }); }
    // after Safari's own edge swipe-back the email is already gone from view: no second slide
    else if ($("#layout.with-pane")) closePane(null, { push: false, focusBack: false, instant: !!e.hasUAVisualTransition });
  });

  // --- actions -------------------------------------------------------------------------------
  let keyAction = false;
  let mouseMoves = Number(store.get("tip:moves") || 0);

  // POST, re-render, then a toast that says what happened (+ Undo where the backend allows).
  // `undo` is a function that reverses the action, or (r) => such a function once the reply is known.
  async function act({ url, body, ok: okText, undo = null, undoFor = null, extra = [], after = null }) {
    const r = await post(url, body);
    if (!r.ok) {
      // Retry only helps when the server was unreachable or failed; a 4xx needs different input,
      // so the page (and whatever was typed) stays exactly as it is
      const retry = r.status === 0 || r.status >= 500;
      if (retry || r.status === 404) { try { await refresh(); } catch { /* keep the page as is */ } } // 404: it's gone, show that
      toast(r.message, { kind: "err", actions: retry ? [{ label: "Retry", run: () => act({ url, body, ok: okText, undo, undoFor, extra, after }) }] : [] });
      return r;
    }
    if (after) await after(r);
    else { try { await refresh(); } catch { /* the action itself is done */ } }
    const reverse = undo || (undoFor ? undoFor(r) : null);
    const entry = reverse ? pushUndo({ run: reverse }) : null;
    const actions = entry ? [{ label: "Undo", run: () => runUndo(entry) }, ...extra] : extra;
    toast(typeof okText === "function" ? okText(r) : okText || r.message, { actions });
    pollStats();
    return r;
  }

  const setRead = (id, value) => post(`/message/${id}/read`, { is_read: value ? "1" : "0" });
  const rescore = (id, prev) => post(`/message/${id}/score`, { importance: prev.imp, urgency: prev.urg, category: prev.cat || "" });
  function scoresOf(id) {
    const d = $(`.detail[data-message="${esc(id)}"]`) || cardEl(id);
    if (!d) return null;
    return { imp: d.dataset.imp || "", urg: d.dataset.urg || "", cat: d.dataset.cat || "", read: d.dataset.read };
  }
  async function removeRule(kind, pattern) {
    // the rule's own remove form lives on the Rules page; find it there
    try {
      const res = await fetch("/rules", { headers: { Accept: "text/html" }, cache: "no-store" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const form = $(`li[data-kind="${esc(kind)}"][data-pattern="${esc(pattern)}"] form`, doc);
      if (!form) return { ok: false, message: "That rule is already gone" };
      return post(new URL(form.getAttribute("action"), location.href).pathname, { next: "/rules" });
    } catch { return { ok: false, message: "Could not reach the dashboard server" }; }
  }

  async function genericSubmit(form, btn) {
    const url = new URL(form.action, location.href).pathname;
    const body = formBody(form, btn);
    let m;
    if ((m = url.match(/^\/message\/(\d+)\/read$/))) {
      const id = m[1];
      const value = body.get("is_read") === "1";
      return act({ url, body, undo: () => setRead(id, !value) });
    }
    if ((m = url.match(/^\/message\/(\d+)\/score$/))) {
      const id = m[1];
      const prev = scoresOf(id);
      const scored = prev && prev.imp && prev.urg;
      return act({ url, body, ok: (r) => (r.data.quadrant ? `Saved — now in ${LABELS[r.data.quadrant]}` : r.message),
        undo: scored ? () => rescore(id, prev) : null });
    }
    if (url === "/rules") {
      const pattern = (body.get("pattern") || "").trim().toLowerCase();
      const kind = body.get("kind");
      // adding a rule that already exists changes nothing, so there is nothing to undo
      const existed = $$("[data-kind][data-pattern]").some((el) => el.dataset.kind === kind && el.dataset.pattern === pattern);
      const r = await act({ url, body,
        undoFor: (res) => (existed || !res.data.pattern ? null : () => removeRule(res.data.kind, res.data.pattern)) });
      if (form.classList.contains("rule-add")) {
        const input = $(".rule-add input[name=pattern]");
        if (r.ok) input?.focus();
        else if (input && r.status && r.status < 500) {
          input.setAttribute("aria-invalid", "true");
          input.focus();
          input.select();
          input.addEventListener("input", () => input.removeAttribute("aria-invalid"), { once: true });
        }
      }
      return r;
    }
    if ((m = url.match(/^\/outbox\/(\d+)\/undo$/))) { undoSend(m[1]); return null; }
    if ((m = url.match(/^\/rules\/(\d+)\/delete$/))) {
      const holder = form.closest("[data-kind][data-pattern]");
      holder?.classList.add("leaving");
      const kind = holder?.dataset.kind;
      const pattern = holder?.dataset.pattern;
      return act({ url, body, undo: kind && pattern ? () => post("/rules", { kind, pattern, next: "/rules" }) : null });
    }
    form.classList.add("busy");
    if (btn) btn.disabled = true;
    const r = await act({ url, body });
    form.classList.remove("busy");
    if (btn && btn.isConnected) btn.disabled = false;
    return r;
  }

  // Optimistic move: instant pressed state, card fades, next email opens, board re-renders.
  async function moveEmail(form, btn) {
    const viaKey = keyAction;
    keyAction = false;
    const detail = form.closest(".detail");
    const id = detail?.dataset.message;
    if (!id || !btn || btn.name !== "move") return genericSubmit(form, btn);
    const key = btn.value;
    const prev = scoresOf(id);
    const scored = prev && prev.imp && prev.urg;
    const buttons = $$(".move", form);
    const before = buttons.find((b) => b.classList.contains("current"));
    buttons.forEach((b) => { const on = b === btn; b.classList.toggle("current", on); b.setAttribute("aria-pressed", String(on)); });
    form.classList.add("pending");
    const card = cardEl(id);
    card?.classList.add("leaving");
    const inPane = !!form.closest("#pane");
    const advance = inPane && root.dataset.advance !== "off";
    const nextId = advance ? neighbourId(id) : null;
    const nextHref = nextId ? hrefFor(nextId) : null;
    const r = await post(form.action, formBody(form, btn));
    form.classList.remove("pending");
    if (!r.ok) {
      buttons.forEach((b) => { const on = b === before; b.classList.toggle("current", on); b.setAttribute("aria-pressed", String(on)); });
      card?.classList.remove("leaving");
      toast(r.message, { kind: "err", actions: [{ label: "Retry", run: () => { if (form.isConnected) form.requestSubmit(btn); else moveById(id, key); } }] });
      return;
    }
    if (advance) {
      if (nextHref) history.pushState(null, "", nextHref);
      else closePane(closeHref(), { focusBack: true });
    }
    try { await refresh({ moved: id, swapPane: !!nextHref || !advance, focusSubject: !viaKey && !!nextHref }); } catch { /* done anyway */ }
    if (nextId) {
      markActive(nextId);
      // the keyboard cursor follows the queue, not the card that just left
      if (focusedCardId() === String(id) && !phone.matches) $(`.card[data-id="${esc(nextId)}"] .card-link`)?.focus({ preventScroll: true });
    }
    let text = `Moved to ${LABELS[key]}`;
    if (!viaKey && finePointer.matches && mouseMoves < 3) {
      mouseMoves += 1;
      store.set("tip:moves", String(mouseMoves));
      text += ` · Tip: press ${KEYS.indexOf(key) + 1} next time`;
    }
    if (scored) {
      // undo puts back the whole prior state, view included: the restored email reopens
      const back = advance && !!$("#pane");
      const entry = pushUndo({ run: async () => {
        const res = await rescore(id, prev);
        if (res.ok && back) history.pushState(null, "", hrefFor(id));
        return res;
      } });
      toast(text, { actions: [{ label: "Undo", run: () => runUndo(entry) }] });
    } else {
      toast(text, { actions: [{ label: "Open", run: () => openMessage(id, hrefFor(id), { focus: true }) }] });
    }
    pollStats();
  }

  // Move a card from the board without opening it (keys 1–4 on a focused card).
  async function moveById(id, key) {
    const prev = scoresOf(id);
    const scored = prev && prev.imp && prev.urg;
    const nextId = neighbourId(id);
    cardEl(id)?.classList.add("leaving");
    const r = await post(`/message/${id}/score`, { move: key });
    if (!r.ok) {
      cardEl(id)?.classList.remove("leaving");
      toast(r.message, { kind: "err", actions: [{ label: "Retry", run: () => moveById(id, key) }] });
      return;
    }
    try { await refresh({ moved: id }); } catch { /* done anyway */ }
    if (nextId) $(`.card[data-id="${esc(nextId)}"] .card-link`)?.focus({ preventScroll: true });
    const text = `Moved to ${LABELS[key]}`;
    if (scored) {
      const entry = pushUndo({ run: () => rescore(id, prev) });
      toast(text, { actions: [{ label: "Undo", run: () => runUndo(entry) }] });
    } else toast(text, { actions: [{ label: "Open", run: () => openMessage(id, hrefFor(id), { focus: true }) }] });
    pollStats();
  }

  // e: mark read and open (or focus) the next email; ⇧U / ⇧I: unread / read.
  async function readKey(value, andNext) {
    const id = openId() ?? focusedCardId() ?? (!$("#pane") ? $(".detail")?.dataset.message ?? null : null);
    if (!id) return;
    const prev = scoresOf(id);
    const wasRead = prev ? prev.read === "1" : !value;
    const nextId = andNext ? neighbourId(id) : null;
    const inPane = paneOpen();
    return act({
      url: `/message/${id}/read`, body: { is_read: value ? "1" : "0" },
      ok: value ? "Marked as read" : "Marked as unread",
      undo: wasRead === value ? null : () => setRead(id, wasRead),
      after: async () => {
        if (andNext && inPane) {
          if (nextId) history.pushState(null, "", hrefFor(nextId));
          else closePane(closeHref(), { focusBack: true });
        }
        try { await refresh({ swapPane: andNext && !!nextId }); } catch { /* done anyway */ }
        if (andNext && nextId) {
          markActive(inPane ? nextId : null);
          if (!inPane) $(`.card[data-id="${esc(nextId)}"] .card-link`)?.focus({ preventScroll: true });
        }
      },
    });
  }

  // --- sync state machine (idle → syncing → done | error | busy elsewhere) -----------------
  let syncing = false;
  function setSyncLabel(text) { const l = $(".sync-label"); if (l) l.textContent = text; }
  async function runSync() {
    if (syncing) return;
    syncing = true;
    const bar = $(".top");
    bar?.classList.remove("is-done");
    bar?.classList.add("is-syncing");
    $$("form[data-sync] button").forEach((b) => { b.setAttribute("aria-disabled", "true"); b.setAttribute("aria-busy", "true"); });
    setSyncLabel("Syncing…");
    schedulePoll(3000);
    const r = await post("/sync", { next: location.pathname + location.search });
    syncing = false;
    bar?.classList.remove("is-syncing");
    $$("form[data-sync] button").forEach((b) => { b.removeAttribute("aria-disabled"); b.removeAttribute("aria-busy"); });
    const busy = r.status === 409 || /already running/i.test(r.message);
    if (r.ok) {
      bar?.classList.add("is-done");
      setSyncLabel("Up to date");
      try { await refresh(); } catch { /* sync itself is done */ }
      toast(r.message);
      setTimeout(() => { bar?.classList.remove("is-done"); setSyncLabel("Sync now"); }, 2000);
    } else if (busy) {
      setSyncLabel("Sync now");
      toast("A sync is already running — numbers update by themselves", { kind: "info" });
    } else {
      setSyncLabel("Sync now");
      try { await refresh(); } catch { /* keep the page */ }
      toast(r.message, { kind: "err", actions: [{ label: "Retry", run: runSync }] });
    }
    pollStats();
  }

  // --- form submit routing -------------------------------------------------------------------
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "filters") { // keep the URL short: leave out empty filters
      e.preventDefault();
      const params = new URLSearchParams(new FormData(form));
      for (const [key, value] of [...params]) if (!value) params.delete(key);
      const query = params.toString();
      go(form.getAttribute("action") + (query ? "?" + query : ""));
      return;
    }
    if (form.hasAttribute("data-compose")) {
      e.preventDefault();
      if (e.submitter?.hasAttribute("data-ai-draft")) aiDraft(form); else sendCompose(form);
      return;
    }
    if (!form.hasAttribute("data-enhance")) return;
    e.preventDefault();
    const btn = e.submitter;
    if (form.hasAttribute("data-sync")) { runSync(); return; }
    if (form.classList.contains("moves")) { moveEmail(form, btn); return; }
    genericSubmit(form, btn);
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches && el.matches("[data-autosubmit]") && el.form) el.form.requestSubmit();
  });

  // --- keyboard ------------------------------------------------------------------------------
  let gTimer = 0;
  function submitMove(key) {
    const btn = $(`#pane .card-moves .move[value="${key}"]`) || (!$("#pane") ? $(`.detail .card-moves .move[value="${key}"]`) : null);
    if (btn && btn.form && (paneOpen() || !$("#pane"))) {
      keyAction = true;
      if (typeof btn.form.requestSubmit === "function") btn.form.requestSubmit(btn); else btn.click();
      return;
    }
    const id = focusedCardId();
    if (id) moveById(id, key);
  }
  function onEscape(e, t) {
    const menu = $("details.menu-wrap[open]:not(.closing)");
    if (menu) { e.preventDefault(); closeMenu(menu, true); return; }
    if (sheetOpen()) { e.preventDefault(); toggleSheet(); return; }
    if (t.matches && t.matches(".search input")) {
      // Esc clears the search and its results (Mail), not just the text in the field
      e.preventDefault();
      const had = t.defaultValue;
      t.value = "";
      t.blur();
      if (had) {
        const u = new URL(location.href);
        u.searchParams.delete("q");
        u.searchParams.delete("open");
        go(u.pathname + u.search);
      }
      return;
    }
    if (drawerOpen()) { e.preventDefault(); closeDrawer(); return; }
    const cw = (t.closest && t.closest(".compose-window")) || (t === document.body ? composeWindow() : null);
    if (cw) { e.preventDefault(); closeWindowKeepingDraft(cw); return; }
    // first Esc leaves a pane field, the next one closes the pane (Mail)
    if (t.closest && t.closest("#pane") && t.matches("input:not([type=radio]):not([type=checkbox]), textarea, select")) {
      e.preventDefault();
      t.blur();
      $("#pane .detail-subject")?.focus({ preventScroll: true });
      return;
    }
    if (t.closest && t.closest("input, textarea, select")) return;
    if (paneOpen() && $("#pane a[data-close]")) { e.preventDefault(); closePane(closeHref()); }
  }
  document.addEventListener("keydown", (e) => {
    if (!e.defaultPrevented && !e.isComposing && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      const form = e.target instanceof Element ? e.target.closest("form[data-compose]") : null;
      if (form) { e.preventDefault(); sendCompose(form); return; }
    }
    if (!e.defaultPrevented && !e.isComposing && e.key === "Enter" && e.target instanceof Element && e.target.matches("[data-help-row] input")) {
      e.preventDefault();
      aiDraft(e.target.form);
      return;
    }
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (composeOpening && e.key.length === 1) { e.preventDefault(); typedAhead += e.key; return; }
    const t = e.target instanceof Element ? e.target : document.body;
    if (e.key === "Escape") { onEscape(e, t); return; }
    if (t.closest("input, textarea, select, [contenteditable]") || t.isContentEditable) return;
    if (root.dataset.keys === "off") return;
    if ($("details.menu-wrap[open]:not(.closing)") || (sheetOpen() && e.key !== "?")) return;
    if (gTimer) {
      clearTimeout(gTimer);
      gTimer = 0;
      const target = { i: "/", a: "/?view=all", l: "/?view=all", m: "/?view=matrix", t: "/sent", r: "/rules" }[e.key];
      if (target) { e.preventDefault(); go(target); }
      return;
    }
    switch (e.key) {
      case "j": case "k": stepEmail(e.key === "j" ? 1 : -1); break;
      case "o": {
        const link = document.activeElement?.closest?.(".card")?.querySelector(".card-link");
        if (link) link.click(); else stepEmail(1);
        break;
      }
      case "1": case "2": case "3": case "4": submitMove(KEYS[Number(e.key) - 1]); break;
      case "e": readKey(true, true); break;
      case "U": if (!e.shiftKey) return; readKey(false, false); break;
      case "I": if (!e.shiftKey) return; readKey(true, false); break;
      case "z": {
        const p = pendingSend();
        if (p) { sends[p.id]?.snack && dismiss(sends[p.id].snack); undoSend(p.id); } else runUndo();
        break;
      }
      case "c": openCompose("/compose?next=" + encodeURIComponent(location.pathname + location.search)); break;
      case "r": case "a": case "f": {
        const link = $(`#pane .reply-bar [data-reply="${{ r: "reply", a: "all", f: "forward" }[e.key]}"]`) || (!$("#pane") ? $(`.detail .reply-bar [data-reply="${{ r: "reply", a: "all", f: "forward" }[e.key]}"]`) : null);
        if (!link) return;
        link.click();
        break;
      }
      case "u": if (paneOpen() && $("#pane a[data-close]")) closePane(closeHref()); else return; break;
      case "/": { const s = $(".search input"); if (!s) return; s.focus(); s.select(); break; }
      case "?": toggleSheet(); break;
      case "g": gTimer = setTimeout(() => { gTimer = 0; }, 1000); break;
      default: return;
    }
    e.preventDefault();
  });

  // --- scroll: toolbar edge fade, dock hide/show -------------------------------------------
  let lastY = window.scrollY;
  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = window.scrollY;
    $(".top")?.classList.toggle("is-scrolled", y > 4);
    const dock = $(".dock");
    const dy = y - lastY;
    if (dock) {
      if (y < 120 || dy < -6) dock.classList.remove("is-hidden");
      else if (dy > 6) dock.classList.add("is-hidden");
    }
    // phones: like Gmail, the Compose button tucks into an icon while you scroll down the list
    const fab = $(".fab");
    if (fab) {
      if (y < 120 || dy < -6) fab.classList.remove("compact");
      else if (dy > 6) fab.classList.add("compact");
    }
    if (Math.abs(dy) > 6 || y < 120) lastY = y;
    const st = $("details.status-wrap[open]:not(.closing)");
    if (st && Math.abs(y - (st._y ?? y)) > 8) closeMenu(st); // a popover stays attached to its trigger
    updateDock();
  }
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });

  // --- phone dock: current quadrant ----------------------------------------------------------
  // The current section is the last one whose top has passed a reading line 30% down the
  // screen; at the very end of the page it is the last section in view.
  let dockHold = 0;
  function setDockCurrent(key) {
    $$(".dock-item").forEach((a) => {
      if (a.dataset.col === key) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    });
  }
  function updateDock() {
    const dock = $(".dock");
    if (!dock || !dock.getClientRects().length) return;
    const now = performance.now();
    if (now < dockHold) { dockHold = now + 200; return; } // a tapped item holds while the jump scrolls
    const cols = $$("section.col");
    if (!cols.length) return;
    const line = 90 + (window.innerHeight - 90) * 0.3;
    let cur = cols.filter((c) => c.getBoundingClientRect().top <= line).pop() || cols[0];
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      cur = cols.filter((c) => c.getBoundingClientRect().top < window.innerHeight).pop() || cur;
    }
    setDockCurrent(cur.dataset.col);
  }

  // --- live numbers: /api/stats polling ------------------------------------------------------
  const baseline = { sorted: null };
  let pollTimer = 0;
  let lastStats = null;
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(pollStats, ms); }
  function hidePill() { const p = $("#new-pill"); if (p) p.hidden = true; }
  function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }
  function applyStats(s) {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = (s.unread_do ? `(${s.unread_do}) ` : "") + base;
    const hero = $(".board-head .hero");
    if (hero) {
      const text = s.unread_do ? `${s.unread_do} to do now` : s.unscored ? "Nothing to do yet" : "Nothing to do now";
      if (hero.textContent.trim() !== text) {
        if (s.unread_do) {
          const n = document.createElement("span");
          n.className = "num";
          n.textContent = String(s.unread_do);
          hero.replaceChildren(n, " to do now");
        } else hero.textContent = text;
      }
    }
    const finished = !!lastStats && lastStats.unscored > 0 && s.unscored === 0;
    const sorted = s.total - s.unscored;
    const strip = $(".sorting");
    if (strip) {
      const total = s.total;
      const count = $(".sorting-count", strip);
      if (count) count.textContent = `${sorted} of ${total} sorted`;
      const meter = $(".meter", strip);
      if (meter) {
        meter.style.setProperty("--p", total ? (sorted / total).toFixed(4) : "0");
        meter.setAttribute("aria-valuemax", String(total));
        meter.setAttribute("aria-valuenow", String(sorted));
        meter.setAttribute("aria-valuetext", `${sorted} of ${total} sorted`);
      }
      const wait = $(".sorting-wait", strip);
      if (wait) wait.textContent = `${s.unscored} waiting`;
      const budget = $(".sorting-budget", strip);
      if (budget && s.ai_calls_max != null) {
        const left = Math.max(0, s.ai_calls_max - s.ai_calls_today);
        const needed = Math.ceil(s.unscored / 20);
        budget.textContent = `Needs ≈${plural(needed, "AI call")} · ${left} left today`;
      }
      if (baseline.sorted == null) baseline.sorted = Number(strip.dataset.sorted);
    }
    if (baseline.sorted == null) baseline.sorted = sorted;
    const fresh = sorted - baseline.sorted;
    const pill = $("#new-pill");
    if (pill && fresh > 0 && $("#board") && !finished) {
      pill.textContent = `${fresh} newly sorted · Show`;
      pill.hidden = false;
    }
    const inboxN = $('.sidebar .nav-item[href="/"]');
    if (inboxN) {
      let n = $(".n", inboxN);
      if (s.unread && !n) { n = document.createElement("span"); n.className = "n num"; inboxN.append(n); }
      if (n) { if (s.unread) n.replaceChildren(String(s.unread), Object.assign(document.createElement("span"), { className: "sr-only", textContent: " unread" })); else n.remove(); }
    }
    const dock = $(".dock");
    // the dock shows filtered counts when filters are on; global stats would contradict them
    if (dock && s.quadrant_unread && !dock.hasAttribute("data-filtered")) {
      $$(".dock-item", dock).forEach((a) => {
        const key = a.dataset.col;
        const n = s.quadrant_unread[key] ?? 0;
        const total = s.quadrants?.[key] ?? n;
        const label = $(".dock-n", a);
        if (label) { label.textContent = String(n || total); label.classList.toggle("is-total", !n); }
        a.setAttribute("aria-label", `${LABELS[key]}, ${n} unread of ${total}`);
      });
    }
    if (finished) {
      // the strip goes away and the columns fill in, then the completion moment
      hidePill();
      const done = () => {
        if (session.get("moment:sorted")) return;
        session.set("moment:sorted", "1");
        moment(`All ${s.total} emails sorted`);
      };
      if ($("#board")) refresh().then(done, done); else done();
    }
    if (lastStats) {
      if (lastStats.unread_do > 0 && s.unread_do === 0 && !session.get("moment:do")) {
        session.set("moment:do", "1");
        moment("Do now is clear ✓");
      }
    }
    lastStats = s;
  }
  async function pollStats() {
    let s;
    try {
      const res = await fetch("/api/stats", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.status === 401) { toLogin(); return; }
      s = await res.json();
    } catch { schedulePoll(120000); return; }
    applyStats(s);
    schedulePoll(syncing ? 3000 : s.unscored > 0 && document.visibilityState === "visible" ? 15000 : 120000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedulePoll(500);
  });


  // --- sidebar: rail on desktop, drawer on tablets and phones --------------------------------
  // The drawer slides in on a spring (phones) or grows out of the rail (tablets), and follows a
  // finger dragging it shut. `.open` = on screen (also while closing); drawerOpen() = open for real.
  const wide = media("(min-width: 1024px)");
  let drawerIsOpen = false;
  const drawerOpen = () => drawerIsOpen;
  const drawerSpring = spring(paintDrawer, { response: 0.38 });
  function paintDrawer(p) {
    const side = $("#sidebar");
    const scrim = $(".scrim");
    if (!side || reduceMotion.matches) return;
    const q = Math.max(0, Math.min(1, p));
    const moving = q > 0 && q < 1;
    side.classList.toggle("moving", moving);
    if (phone.matches) {
      side.style.clipPath = "";
      side.style.transform = q >= 1 ? "" : `translate3d(${((q - 1) * 100).toFixed(3)}%, 0, 0)`;
    } else {
      // the rail is the drawer's left edge: reveal the rest (and its shadow) to the right of it
      side.style.transform = "";
      side.style.clipPath = q >= 1 ? "" : `inset(-24px calc(${(1 - q).toFixed(4)} * (100% - var(--rail-w)) - ${(24 * q).toFixed(2)}px) -24px 0)`;
    }
    if (scrim) scrim.style.opacity = q >= 1 ? "" : String(q);
  }
  function settleDrawer() {
    const side = $("#sidebar");
    const scrim = $(".scrim");
    if (!drawerIsOpen) {
      side?.classList.remove("open");
      scrim?.setAttribute("hidden", "");
    }
    if (side) { side.style.transform = ""; side.style.clipPath = ""; side.classList.remove("moving"); }
    if (scrim) { scrim.style.opacity = ""; scrim.style.pointerEvents = ""; }
  }
  function openDrawer() {
    const side = $("#sidebar");
    if (!side) return;
    drawerIsOpen = true;
    if (!side.classList.contains("open")) { drawerSpring.set(0); side.classList.add("open"); paintDrawer(0); }
    const scrim = $(".scrim");
    if (scrim) { scrim.removeAttribute("hidden"); scrim.style.pointerEvents = ""; }
    $("[data-drawer]")?.setAttribute("aria-expanded", "true");
    syncModal();
    $(".nav-item[aria-current], .compose-btn", side)?.focus({ preventScroll: true });
    if (reduceMotion.matches) { drawerSpring.set(1); settleDrawer(); }
    else drawerSpring.to(1, { rest: settleDrawer });
  }
  function closeDrawer({ instant = false, velocity } = {}) {
    const side = $("#sidebar");
    if (!side?.classList.contains("open")) return;
    const wasOpen = drawerIsOpen;
    drawerIsOpen = false;
    const scrim = $(".scrim");
    if (scrim) scrim.style.pointerEvents = "none"; // while it fades, taps reach the page beneath
    $("[data-drawer]")?.setAttribute("aria-expanded", "false");
    syncModal();
    if (wasOpen && (side.contains(document.activeElement) || document.activeElement === document.body)) {
      $("[data-drawer]")?.focus({ preventScroll: true });
    }
    if (instant || reduceMotion.matches) { drawerSpring.set(0); settleDrawer(); }
    else drawerSpring.to(0, { velocity, rest: settleDrawer });
  }
  // drag the drawer (or the dimmed page beside it) to the left to close it
  let drawerW = 300, drawerFrom = 1;
  drag({
    axis: "x",
    grab: (e) => (drawerIsOpen && !wide.matches && !reduceMotion.matches
      ? e.target.closest?.("#sidebar.open, .scrim:not([hidden])") : null),
    start: () => {
      // tablets reveal everything right of the icon rail, so that's the distance a finger covers
      const w = $("#sidebar")?.getBoundingClientRect().width || 300;
      drawerW = phone.matches ? w : Math.max(120, w - 72);
      drawerFrom = drawerSpring.value; // caught mid-flight: it moves on from there
      drawerSpring.set(drawerFrom);
    },
    move: (d) => {
      const p = drawerFrom + d / drawerW;
      drawerSpring.set(p <= 1 ? p : 1 + rubberband(p - 1, 1) * 0.1);
    },
    end: (d, v) => {
      const at = Math.min(1, drawerFrom + d / drawerW);
      const vel = v / drawerW;
      if (at + projection(v) / drawerW < 0.5) closeDrawer({ velocity: vel });
      else drawerSpring.to(1, { velocity: vel, rest: settleDrawer });
    },
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-drawer]")) {
      if (wide.matches) {
        const on = root.dataset.rail !== "on";
        if (on) root.dataset.rail = "on"; else delete root.dataset.rail;
        store.set("pref:rail", on ? "on" : "off");
      } else if (drawerOpen()) closeDrawer(); else openDrawer();
      return;
    }
    if (e.target.closest("[data-drawer-close]") || (drawerOpen() && e.target.closest("#sidebar a"))) closeDrawer();
  });
  wide.addEventListener?.("change", () => closeDrawer({ instant: true }));
  phone.addEventListener?.("change", () => { if (drawerIsOpen) { drawerSpring.set(1); settleDrawer(); } });

  // --- compose: floating window (new mail), inline under an email (replies), full page --------
  const UNDO_FALLBACK = 10;
  const composeWindow = () => $("#compose-dock .compose-window:not(.leaving)");
  // a compose box leaves the way it came (down, or back into the page) before it's removed
  function leave(el) {
    if (!el?.isConnected) return;
    if (reduceMotion.matches && !el.classList.contains("compose-window")) { el.remove(); return; }
    el.classList.remove("dragging");
    el.style.transform = ""; // a dragged sheet leaves from where the finger let go
    el.classList.add("leaving");
    if (el.contains(document.activeElement)) document.activeElement.blur();
    el.inert = true;
    setTimeout(() => el.remove(), reduceMotion.matches ? 160 : 340);
  }
  const draftKey = (form) => form?.dataset.draftKey || "";
  const fieldsOf = (form) => ({
    to: form.elements.to?.value || "", cc: form.elements.cc?.value || "", bcc: form.elements.bcc?.value || "",
    subject: form.elements.subject?.value || "", body: form.elements.body?.value || "",
    from: form.elements.from_account?.value || "",
  });
  // the email waiting in its Undo time (or, with `settling`, one whose result isn't shown yet)
  function pendingSend(settling = false) {
    let p = null;
    try { p = JSON.parse(session.get("outbox:pending") || "null"); } catch { p = null; }
    return p && p.id && p.until > Date.now() - (settling ? 120000 : 0) ? p : null;
  }
  function clearPending(id) {
    const p = pendingSend(true);
    if (!p || String(p.id) === String(id)) session.set("outbox:pending", "");
  }
  function setStatus(form, text) { const s = $("[data-compose-status]", form); if (s) s.textContent = text; }
  function saveDraft(form) {
    clearTimeout(form._saveTimer);
    // a sent or closed form never writes itself back (it would come back as "Draft restored")
    if (!draftKey(form) || form.dataset.sent || !form.isConnected) return;
    const f = fieldsOf(form);
    if (!f.body.trim() && !f.to.trim() && !f.subject.trim()) { forgetDraft(form); return; }
    store.set(draftKey(form), JSON.stringify({ ...f, at: Date.now() }));
    setStatus(form, "Draft saved");
  }
  function forgetDraft(form) {
    clearTimeout(form._saveTimer);
    try { localStorage.removeItem(draftKey(form)); } catch { /* storage blocked */ }
  }
  function restoreDraft(form) {
    if (form.dataset.restored || form.elements.draft_id) return; // an undone/failed email brings its own text
    form.dataset.restored = "1";
    let d = null;
    try { d = JSON.parse(store.get(draftKey(form)) || "null"); } catch { d = null; }
    if (!d || !d.body || form.elements.body.value.trim()) return;
    if (Date.now() - (d.at || 0) > 14 * 864e5) { forgetDraft(form); return; }
    for (const k of ["to", "cc", "bcc", "subject", "body"]) if (form.elements[k] && d[k] != null && (k === "body" || d[k])) form.elements[k].value = d[k];
    if (d.from && form.elements.from_account) form.elements.from_account.value = d.from;
    if (d.cc || d.bcc) showCc(form);
    setStatus(form, "Draft restored");
  }
  function showCc(form) {
    $$(".cc-row", form).forEach((r) => r.classList.remove("js-collapsed"));
    $("[data-cc-links]", form)?.classList.add("js-hidden");
  }
  function enhanceCompose(form) {
    if (!form || form.dataset.ready) return;
    form.dataset.ready = "1";
    restoreDraft(form);
    form.addEventListener("input", () => {
      clearTimeout(form._saveTimer);
      setStatus(form, "");
      form._saveTimer = setTimeout(() => saveDraft(form), 600);
    });
    form.addEventListener("change", () => saveDraft(form));
  }
  // nothing typed while a reply or compose box is on its way is lost, or taken as a shortcut
  let composeOpening = false;
  let typedAhead = "";
  function focusCompose(form) {
    const empty = ["to", "subject"].map((k) => form.elements[k]).find((el) => el && el.type !== "hidden" && !el.value.trim());
    const target = form.dataset.mode === "reply" || form.dataset.mode === "all" ? form.elements.body : empty || form.elements.body;
    target?.focus({ preventScroll: false });
    if (target === form.elements.body && !typedAhead) target.setSelectionRange(0, 0);
    if (typedAhead && target) {
      try { target.setRangeText(typedAhead, target.selectionStart, target.selectionEnd, "end"); } catch { target.value += typedAhead; }
      typedAhead = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  async function fetchCompose(href, variant) {
    const url = new URL(href, location.href);
    url.searchParams.set("partial", variant);
    const res = await fetch(url, { headers: { Accept: "text/html" } });
    if (res.status === 401) { toLogin(); return null; }
    if (!res.ok) throw new Error(String(res.status));
    const tpl = document.createElement("template");
    tpl.innerHTML = (await res.text()).trim(); // rendered by our server; everything is escaped
    return tpl.content.firstElementChild;
  }
  async function openCompose(href, { replace = false } = {}) {
    const dock = $("#compose-dock");
    if (!dock) { location.href = href; return; }
    const open = composeWindow();
    if (open) {
      open.classList.remove("minimized");
      const f = fieldsOf(open);
      if (!replace && (f.body.trim() || f.to.trim())) {
        // one window at a time (Gmail stacks them; one keeps it simple): bring it back
        focusCompose(open);
        toast("Finish or close the message you're writing first", { kind: "info" });
        return;
      }
      saveDraft(open); // replaced (e.g. by an undone email): it waits as a draft
      open.dataset.sent = "1";
      open.remove();
    }
    composeOpening = true;
    let form;
    try { form = await fetchCompose(href, "window"); } catch { composeOpening = false; location.href = href; return; } finally { composeOpening = false; }
    if (!form) return;
    dock.append(form);
    enhanceCompose(form);
    focusCompose(form);
    if (phone.matches && history.state?.compose !== 1) history.pushState({ ...(history.state || {}), compose: 1 }, "");
    syncModal();
  }
  async function openReply(link) {
    const slot = link.closest(".detail")?.querySelector("[data-reply-slot]");
    if (!slot) { location.href = link.href; return; }
    const current = $("[data-compose]:not(.leaving)", slot);
    if (current && current.dataset.mode === link.dataset.reply) { focusCompose(current); return; }
    if (current && fieldsOf(current).body.trim()) {
      if (!confirm("Discard the reply you're writing?")) return;
      forgetDraft(current);
      current.dataset.sent = "1";
    }
    composeOpening = true;
    let form;
    try { form = await fetchCompose(link.href, "inline"); } catch { composeOpening = false; location.href = link.href; return; } finally { composeOpening = false; }
    if (!form) return;
    if (!slot.isConnected) { typedAhead = ""; return; } // the email changed meanwhile
    slot.replaceChildren(form);
    enhanceCompose(form);
    form.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
    focusCompose(form);
  }
  function closeCompose(form) {
    if (form.classList.contains("compose-page")) { location.href = form.elements.next?.value || "/"; return; }
    form.dataset.sent = form.dataset.sent || "closed";
    clearTimeout(form._saveTimer);
    const win = form.classList.contains("compose-window");
    leave(form);
    if (win && history.state?.compose === 1) history.back();
    syncModal();
  }
  function closeWindowKeepingDraft(form) {
    saveDraft(form);
    const had = fieldsOf(form).body.trim();
    closeCompose(form);
    if (had) toast("Draft saved on this device", { kind: "info" });
  }
  let sheetH = 600;
  drag({
    axis: "y",
    grab: (e) => (phone.matches && !reduceMotion.matches && !e.target.closest("button")
      ? e.target.closest(".compose-window:not(.minimized):not(.leaving) .compose-head")?.closest(".compose-window") : null),
    start: (d, win) => { if (d <= 0) return false; sheetH = win.getBoundingClientRect().height || innerHeight; },
    move: (d, win) => { win.style.transform = `translate3d(0, ${d >= 0 ? d : -rubberband(-d, sheetH) * 0.2}px, 0)`; },
    end: (d, v, win) => {
      if (Math.max(0, d) + projection(v) > sheetH * 0.3) closeWindowKeepingDraft(win);
      else win.style.transform = ""; // springs back up (CSS transition from where it is)
    },
  });
  function invalid(form, field, message) {
    const el = field && form.elements[field];
    if (el && el.type !== "hidden") {
      if (field === "cc" || field === "bcc") showCc(form);
      el.setAttribute("aria-invalid", "true");
      el.focus();
      el.addEventListener("input", () => el.removeAttribute("aria-invalid"), { once: true });
    }
    toast(message, { kind: "err" });
  }
  async function sendCompose(form) {
    if (form.classList.contains("busy")) return;
    const f = fieldsOf(form);
    if (!f.to.trim() && !f.cc.trim() && !f.bcc.trim()) { invalid(form, "to", "Add at least one recipient."); return; }
    if (form.elements.subject?.type !== "hidden" && !f.subject.trim() && !confirm("Send this message without a subject?")) return;
    clearTimeout(form._saveTimer);
    form.classList.add("busy");
    const r = await post(form.getAttribute("action"), formBody(form));
    form.classList.remove("busy");
    if (!r.ok) { invalid(form, r.data.field, r.message); return; }
    form.dataset.sent = "1";
    forgetDraft(form);
    const next = r.data.next || "/";
    const pending = { id: r.data.id, until: Date.now() + (r.data.undo_seconds || UNDO_FALLBACK) * 1000 };
    if (form.classList.contains("compose-page")) {
      session.set("outbox:pending", JSON.stringify(pending));
      location.href = next;
      return;
    }
    closeCompose(form);
    trackSend(pending);
  }
  // Snackbar while the email waits (Undo), then "Message sent" or what went wrong.
  const sends = {}; // outbox id -> { snack, poll }
  function trackSend(p) {
    session.set("outbox:pending", JSON.stringify(p));
    settle(p.id);
    const t = sends[p.id] = { snack: null, poll: 0 };
    const left = p.until - Date.now();
    if (left > 500) {
      t.snack = toast("Sending…", { timeout: left, keep: true, actions: [
        { label: "Undo", run: () => undoSend(p.id) },
        { label: "View", key: false, run: () => { location.href = `/sent#s${p.id}`; } }] });
      // the Undo time is real: the snackbar goes when it's over, even while hovered or focused
      if (t.snack) t.snack._end = setTimeout(() => dismiss(t.snack), left);
      if (t.snack && document.activeElement === document.body) $(".flash-btn", t.snack)?.focus({ preventScroll: true });
    }
    t.poll = setTimeout(() => pollSend(p.id, 0), Math.max(left, 0) + 2500);
  }
  // stop following one email: its snackbar goes and it isn't asked about again
  function settle(id) {
    const t = sends[id];
    if (!t) return;
    delete sends[id];
    clearTimeout(t.poll);
    if (t.snack) { clearTimeout(t.snack._end); dismiss(t.snack); }
  }
  async function pollSend(id, tries) {
    if (!sends[id]) return; // undone (or followed again) meanwhile
    let s;
    try {
      const res = await fetch(`/api/outbox/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (res.status === 401) { toLogin(); return; }
      if (res.status === 404) { settle(id); clearPending(id); return; } // discarded, or sent again as a new email
      s = await res.json();
    } catch { s = null; }
    if (!sends[id]) return;
    if (s && s.status === "sent") {
      settle(id);
      clearPending(id);
      toast(s.note ? `Sent, but ${s.note.charAt(0).toLowerCase()}${s.note.slice(1)}` : "Message sent", { kind: s.note ? "info" : "ok", actions: [{ label: "View", run: () => { location.href = `/sent#s${id}`; } }] });
      if ($("#board")) refresh().catch(() => {});
      return;
    }
    if (s && s.status === "failed") {
      settle(id);
      clearPending(id);
      toast(`Not sent: ${s.error || "something went wrong"}`, { kind: "err", actions: [{ label: "Edit", run: () => openCompose(`/compose?draft=${id}`, { replace: true }) }] });
      if ($("#board")) refresh().catch(() => {});
      return;
    }
    if (s && s.status === "cancelled") { settle(id); clearPending(id); return; }
    if (tries < 20) sends[id].poll = setTimeout(() => pollSend(id, tries + 1), 3000);
    else settle(id);
  }
  let undoing = null;
  async function undoSend(id) {
    if (undoing === String(id)) return; // pressed twice
    undoing = String(id);
    const r = await post(`/outbox/${encodeURIComponent(id)}/undo`, {});
    undoing = null;
    if (!r.ok) { toast(r.message, { kind: "err" }); return; } // too late: "Message sent" follows
    settle(id);
    clearPending(id);
    toast("Sending undone", { kind: "info" });
    if (!$("#compose-dock")) { location.href = r.data.edit_url || `/compose?draft=${id}`; return; }
    // the undone email opens for editing; one being written is kept as a draft
    openCompose(r.data.edit_url || `/compose?draft=${id}`, { replace: true });
    if (location.pathname === "/sent") refresh().catch(() => {});
  }
  async function aiDraft(form) {
    if (!form || form.classList.contains("writing")) return;
    const row = $("[data-help-row]", form);
    if (row?.classList.contains("js-collapsed")) { toggleHelp(form, true); return; }
    const body = form.elements.body;
    const before = body.value;
    form.classList.add("writing");
    setStatus(form, "Writing…");
    const r = await post("/compose/draft", formBody(form));
    form.classList.remove("writing");
    setStatus(form, "");
    if (!r.ok) { toast(r.message, { kind: "err" }); return; }
    body.value = r.data.text || "";
    // the whole draft is in view before anything can be sent
    body.style.height = "";
    if (body.scrollHeight > body.clientHeight) body.style.height = Math.min(body.scrollHeight + 4, innerHeight * 0.7) + "px";
    saveDraft(form);
    body.focus();
    body.setSelectionRange(0, 0);
    body.scrollTop = 0;
    toast("Draft ready: read it and edit before sending", { actions: before.trim() ? [{ label: "Undo", key: false, run: () => { body.value = before; saveDraft(form); } }] : [] });
  }
  function toggleHelp(form, show) {
    const row = $("[data-help-row]", form);
    const btn = $("[data-help-toggle]", form);
    if (!row) return;
    const on = show ?? row.classList.contains("js-collapsed");
    row.classList.toggle("js-collapsed", !on);
    btn?.setAttribute("aria-expanded", String(on));
    if (on) $("input", row)?.focus();
  }
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    const reply = t.closest("a[data-reply]");
    if (reply && reply.closest("#pane, .detail-page")) { e.preventDefault(); openReply(reply); return; }
    const neu = t.closest("a[data-compose-new], a[data-compose-draft]");
    if (neu && $("#compose-dock")) {
      e.preventDefault();
      closeDrawer();
      openCompose(neu.getAttribute("href"), { replace: neu.hasAttribute("data-compose-draft") });
      return;
    }
    const form = t.closest("form[data-compose]");
    if (!form) return;
    if (t.closest("[data-show-cc]")) { showCc(form); form.elements.cc?.focus(); return; }
    if (t.closest("[data-help-toggle]")) { toggleHelp(form); return; }
    if (t.closest("[data-compose-min]")) { form.classList.toggle("minimized"); form.classList.remove("maximized"); syncModal(); return; }
    if (t.closest("[data-compose-max]")) { form.classList.toggle("maximized"); form.classList.remove("minimized"); return; }
    if (t.closest(".compose-head") && form.classList.contains("minimized") && !t.closest("button")) { form.classList.remove("minimized"); syncModal(); focusCompose(form); return; }
    if (t.closest("[data-compose-close]")) { closeWindowKeepingDraft(form); return; }
    if (t.closest("[data-compose-discard]")) {
      e.preventDefault();
      const f = fieldsOf(form);
      if ((f.body.trim() || f.to.trim()) && !confirm("Discard this draft?")) return;
      form.dataset.sent = "discarded";
      forgetDraft(form);
      closeCompose(form);
      toast("Draft discarded", { kind: "info" });
    }
  });
  // phone: Back closes the full-screen compose (the draft is kept), like Gmail's app
  window.addEventListener("popstate", (e) => {
    const win = composeWindow();
    if (win && history.state?.compose !== 1) {
      saveDraft(win); win.dataset.sent = "closed";
      if (e.hasUAVisualTransition) win.remove(); else leave(win);
      syncModal();
    }
  });
  // leaving the page keeps what was typed in the last moment
  window.addEventListener("pagehide", () => $$("form[data-compose]").forEach(saveDraft));
  // logging out forgets the drafts this browser kept
  document.addEventListener("submit", (e) => {
    if (!e.target.matches?.(".logout-form")) return;
    try { Object.keys(localStorage).filter((k) => k.startsWith("draft:")).forEach((k) => localStorage.removeItem(k)); } catch { /* storage blocked */ }
    session.set("outbox:pending", "");
  }, true);
  // a send that was still waiting when the page changed (or a full-page compose just sent)
  (() => { const p = pendingSend(true); if (p) trackSend(p); })();
  $$("form[data-compose]").forEach((f) => { enhanceCompose(f); if (f.classList.contains("compose-page")) focusCompose(f); });
  // Sent: "View" opens that email
  (() => {
    const m = location.hash.match(/^#s(\d+)$/);
    const item = m && document.getElementById(`s${m[1]}`);
    const d = item && $("details", item);
    if (d) { d.open = true; $("summary", d)?.focus({ preventScroll: true }); item.scrollIntoView({ block: "center" }); }
  })();

  // --- start ---------------------------------------------------------------------------------
  shownKey = pageKey();
  // once the inbox has settled, fetch the other tabs one by one (~10 KB each), so the first
  // tap on any of them is instant too
  if ($(".tabs")) {
    const warm = async () => {
      for (const t of [...$$(".tab:not([aria-current])"), ...$$(".tab[aria-current]")]) { // this one too, for coming back
        if (document.visibilityState !== "visible") return;
        try { await prefetch(t.href, SHOW_CACHED_MS); } catch { return; }
      }
    };
    setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(warm, { timeout: 4000 }) : warm()), 1500);
  }
  restoreColumns();
  syncSwitches();
  setupNav();
  onScroll();
  syncModal();
  if (phone.matches && paneOpen()) $("#pane .detail-subject")?.focus({ preventScroll: true }); // /?open=N on a phone
  schedulePoll(2000);
})();
