// Applies the saved UI language before the app renders (no RTL/LTR flash). Same-origin: allowed by the CSP.
(function () {
  try {
    var l = localStorage.getItem("ef.locale");
    if (l === "en") {
      document.documentElement.lang = "en";
      document.documentElement.dir = "ltr";
    }
  } catch (e) {
    /* storage unavailable: keep Arabic defaults */
  }
})();
