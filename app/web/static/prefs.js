(function () {
  // Apply saved display preferences before the first paint (no flash of the wrong density/material).
  var d = document.documentElement;
  function get(k) { try { return localStorage.getItem("pref:" + k); } catch (e) { return null; } }
  if (get("density") === "compact") d.setAttribute("data-density", "compact");
  if (get("glass") === "off") d.setAttribute("data-glass", "off");
  if (get("keys") === "off") d.setAttribute("data-keys", "off");
  if (get("advance") === "off") d.setAttribute("data-advance", "off");
  d.classList.add("js");
})();
