/* force-motion: a shared drop-in that keeps animations on regardless of reduced-motion settings; kept verbatim.
   Loaded as an external file because Manifest V3 extension pages forbid inline scripts. */
(function () {
  "use strict";
  // 1) JS motion libraries (Framer Motion, GSAP, AOS, Swiper, Lenis, ScrollReveal,
  //    Motion One, react-spring, ...) read window.matchMedia. Make every
  //    reduced-motion probe report "no preference".
  try {
    var native = window.matchMedia;
    if (native) {
      native = native.bind(window);
      var fake = function (q) {
        return {
          media: q, matches: /no-preference/i.test(q), onchange: null,
          addListener: function () {}, removeListener: function () {},
          addEventListener: function () {}, removeEventListener: function () {},
          dispatchEvent: function () { return false; }
        };
      };
      window.matchMedia = function (q) {
        return (typeof q === "string" && /prefers-reduced-motion/i.test(q)) ? fake(q) : native(q);
      };
    }
  } catch (e) {}
  // 2) CSS suppressors — delete "@media (prefers-reduced-motion: reduce)" blocks
  //    (Bootstrap Reboot, animate.css, hand-written guards) from same-origin
  //    stylesheets, so each element's OWN animation/transition values apply
  //    again. Cross-origin (CDN) sheets are unreadable and skipped — host your
  //    framework CSS same-origin, or don't self-gate, for the CSS side to reach.
  function walk(sheet) {
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return; } // cross-origin: unreadable
    if (!rules) return;
    for (var i = rules.length - 1; i >= 0; i--) {
      var r = rules[i], cond = (r && (r.conditionText || (r.media && r.media.mediaText))) || "";
      if (r && r.type === 4 && /prefers-reduced-motion\s*:\s*reduce/i.test(cond)) {
        try { sheet.deleteRule(i); } catch (e) {}
      } else if (r && r.styleSheet) {
        walk(r.styleSheet); // @import
      }
    }
  }
  function run() { var s = document.styleSheets; for (var i = 0; i < s.length; i++) walk(s[i]); }
  run();
  document.addEventListener("DOMContentLoaded", run);
  window.addEventListener("load", run);
})();
