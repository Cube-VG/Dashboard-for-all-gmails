(function () {
  // Apply saved display preferences before the first paint (no flash of the wrong density/material).
  var d = document.documentElement;
  function get(k) { try { return localStorage.getItem("pref:" + k); } catch (e) { return null; } }
  var theme = get("theme");
  if (theme === "light" || theme === "dark") {
    d.setAttribute("data-theme", theme);
    // browser chrome (Safari's tab bar tint, form controls) follows the chosen theme too
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", theme === "dark" ? "#0e0f0c" : "#e8ebe6");
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute("content", theme);
  }
  if (get("density") === "compact") d.setAttribute("data-density", "compact");
  if (get("glass") === "off") d.setAttribute("data-glass", "off");
  if (get("keys") === "off") d.setAttribute("data-keys", "off");
  if (get("advance") === "off") d.setAttribute("data-advance", "off");
  if (get("split") === "on") d.setAttribute("data-split", "on");
  if (get("rail") === "on") d.setAttribute("data-rail", "on");
  // signed out (or the session ended): unsent drafts in this browser go too
  if (location.pathname === "/login") {
    try {
      for (var k = localStorage.length - 1; k >= 0; k--) {
        var key = localStorage.key(k);
        if (key && key.indexOf("draft:") === 0) localStorage.removeItem(key);
      }
      sessionStorage.removeItem("outbox:pending");
    } catch (e) { /* storage blocked: nothing saved */ }
  }
  d.classList.add("js");
})();
