(function () {
  var toggle = document.getElementById("navToggle");
  var links = document.querySelector(".nav-links");
  if (!toggle || !links) return;

  var hamburgerIcon = '<path d="M4 7h16M4 12h16M4 17h16"></path>';
  var closeIcon = '<path d="M6 6l12 12M18 6L6 18"></path>';

  function setOpen(isOpen) {
    links.classList.toggle("is-open", isOpen);
    toggle.querySelector("svg").innerHTML = isOpen ? closeIcon : hamburgerIcon;
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  toggle.addEventListener("click", function () {
    setOpen(!links.classList.contains("is-open"));
  });

  links.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("click", function () { setOpen(false); });
  });
})();
