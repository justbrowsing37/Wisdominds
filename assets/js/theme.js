// Shared light/dark theme toggle, loaded at the end of every page (like
// nav-toggle.js). The tiny bootstrap in each page's <head> already applied any
// saved theme to <html data-theme> before first paint to avoid a flash; this
// just wires the toggle button and keeps its icon + aria state in sync.
(function () {
  var root = document.documentElement;
  var toggle = document.getElementById("themeToggle");
  if (!toggle) return;

  var sunIcon = '<circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"></path>';
  var moonIcon = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z"></path>';

  function currentTheme() { return root.getAttribute("data-theme") || "light"; }
  function paint(theme) {
    var svg = toggle.querySelector("svg");
    if (svg) svg.innerHTML = theme === "dark" ? sunIcon : moonIcon;
    toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    toggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }

  paint(currentTheme());
  toggle.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("wisdominds-theme", next);
    paint(next);
  });
})();
