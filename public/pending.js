/*
 * Pending state for every action. A submitted form disables its submitter, swaps the submitter's
 * label for its data-working-label (default: <body data-working-label>) and sets aria-busy on
 * the form until the page answers. HTMX requests from other elements (Byt, Välj rätt) get the same
 * treatment, with aria-busy on the region the request updates (its hx-target, else the element).
 */
(function () {
  "use strict";

  function workingLabelFor(el) {
    var own = el.closest("[data-working-label]");
    return own ? own.getAttribute("data-working-label") : "";
  }

  function start(el, region) {
    if (!el || el.dataset.pending) return;
    el.dataset.pending = "1";
    el.dataset.idleLabel = el.tagName === "INPUT" ? el.value : el.textContent;
    var text = workingLabelFor(el);
    if (text) {
      if (el.tagName === "INPUT") el.value = text;
      else el.textContent = text;
    }
    el.disabled = true;
    if (region) region.setAttribute("aria-busy", "true");
  }

  function stop(el, region) {
    if (!el || !el.dataset.pending) return;
    if (el.tagName === "INPUT") el.value = el.dataset.idleLabel;
    else el.textContent = el.dataset.idleLabel;
    el.disabled = false;
    delete el.dataset.pending;
    delete el.dataset.idleLabel;
    if (region) region.removeAttribute("aria-busy");
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var submitter = event.submitter || form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (!submitter) {
      form.setAttribute("aria-busy", "true");
      return;
    }
    // Disable after the browser has built the form data: a disabled submitter is left out of it.
    setTimeout(function () {
      start(submitter, form);
    }, 0);
  });

  /** The region an HTMX request from `el` updates: its swap target, else the element itself. */
  function busyRegion(event, el) {
    return (event.detail && event.detail.target) || el;
  }

  document.addEventListener("htmx:beforeRequest", function (event) {
    var el = event.detail && event.detail.elt;
    if (el && el.tagName !== "FORM" && /^(BUTTON|INPUT|A)$/.test(el.tagName)) start(el, busyRegion(event, el));
  });

  document.addEventListener("htmx:afterRequest", function (event) {
    var el = event.detail && event.detail.elt;
    if (!el) return;
    if (el.tagName === "FORM") {
      var btn = el.querySelector("[data-pending]");
      stop(btn, el);
    } else stop(el, busyRegion(event, el));
  });

  // Back/forward restores the page from cache with the busy state still on it.
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    document.querySelectorAll("[data-pending]").forEach(function (el) {
      stop(el, el.form || el.closest("form"));
    });
    document.querySelectorAll("[aria-busy]").forEach(function (el) {
      el.removeAttribute("aria-busy");
    });
  });
})();
