// The shell's offline glue (ADR-0007), loaded with `defer` on every page from
// /assets/offline-page.js, so the elements page() renders already exist. Plain browser script.
// Texts come from the page's `<script type="application/json" id="offline-texts">`.

// The online signal: the app is online when a request succeeds, not by the browser's flag. It
// starts from the `<html data-online>` the page arrived with (an Offline Copy arrives with "0");
// the worker's connectivity messages flip it; offline it pings /health every 10 s and goes
// online only on an ok answer. Offline, online-only buttons are disabled and htmx requests (the
// Plan Run banner polling) are cancelled; a write from a form (a tick, a hand-add) is sent as the
// plain form post it is underneath instead, which the worker queues as a Pending Change and answers
// with the page, where the Offline Copy shows it. Back online, it asks the worker to replay Pending Changes.
(function () {
  var root = document.documentElement;
  var online = document.documentElement.dataset.online !== "0";
  var timer = null;
  function apply() {
    root.dataset.online = online ? "1" : "0";
    var controls = document.querySelectorAll("form[data-online-only] button, form[data-online-only] input[type=submit]");
    for (var i = 0; i < controls.length; i++) controls[i].disabled = !online;
  }
  function ping() {
    fetch("/health", { cache: "no-store" }).then(function (res) { if (res.ok) set(true); }, function () {});
  }
  function set(next) {
    if (next === online) return;
    var wasOffline = !online;
    online = next;
    apply();
    if (online) {
      clearInterval(timer);
      timer = null;
      var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (wasOffline && controller) controller.postMessage({ type: "replay" });
    } else if (!timer) {
      timer = setInterval(ping, 10000);
    }
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "connectivity") set(Boolean(event.data.online));
    });
  }
  document.addEventListener("htmx:beforeRequest", function (event) {
    if (online) return;
    event.preventDefault();
    var elt = event.detail && event.detail.elt;
    var form = elt && elt.closest ? elt.closest("form") : null;
    if (form && form.method === "post" && !form.hasAttribute("data-online-only")) HTMLFormElement.prototype.submit.call(form);
  });
  apply();
  if (!online) timer = setInterval(ping, 10000);
})();

// The Pending Changes badge: asks the worker for the Pending Changes (with the page language, so
// each entry comes back labelled) on load and whenever the worker says they changed, and renders
// them with textContent only. Discard tells the worker, which broadcasts the change.
(function () {
  if (!("serviceWorker" in navigator)) return;
  var box = document.getElementById("pending-changes");
  var toggle = document.getElementById("pending-changes-toggle");
  var list = document.getElementById("pending-changes-list");
  var note = document.getElementById("pending-changes-note");
  var textsElement = document.getElementById("offline-texts");
  if (!box || !toggle || !list || !note || !textsElement) return;
  var texts = JSON.parse(textsElement.textContent);
  var lang = box.dataset.lang;
  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, function (whole, name) { return name in values ? String(values[name]) : whole; });
  }
  function time(iso) {
    return new Date(iso).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  }
  function row(entry, worker) {
    var li = document.createElement("li");
    li.className = "row with-actions";
    var label = document.createElement("p");
    label.textContent = entry.label + " " + time(entry.createdAt);
    var state = document.createElement("p");
    if (entry.state === "failed") {
      state.className = "notice";
      state.textContent = fill(texts.failed, { reason: entry.reason || "" });
    } else {
      state.className = "muted";
      state.textContent = texts.pendingState;
    }
    var discard = document.createElement("button");
    discard.type = "button";
    discard.className = "quiet";
    discard.textContent = texts.discard;
    discard.addEventListener("click", function () { worker.postMessage({ type: "discard", id: entry.id }); });
    li.append(label, state, discard);
    return li;
  }
  // Offline, the copy itself shows each Pending Change on its line and the banner carries the
  // count, so the badge only appears for a failed replay. Online it lists everything still queued.
  function render(entries, worker, background) {
    var offline = document.documentElement.dataset.online === "0";
    var failed = entries.some(function (entry) { return entry.state === "failed"; });
    box.hidden = entries.length === 0 || (offline && !failed);
    if (box.hidden) list.hidden = true;
    toggle.textContent = entries.length === 1 ? texts.pendingOne : fill(texts.pending, { n: entries.length });
    toggle.setAttribute("aria-expanded", String(!list.hidden));
    list.replaceChildren.apply(list, entries.map(function (entry) { return row(entry, worker); }));
    note.textContent = background ? texts.replayBackground : texts.replayNextOpen;
  }
  function refresh() {
    navigator.serviceWorker.ready.then(function (registration) {
      var worker = navigator.serviceWorker.controller || registration.active;
      if (!worker) return;
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) { render(event.data.entries, worker, "sync" in registration); };
      worker.postMessage({ type: "queue", lang: lang }, [channel.port2]);
    });
  }
  toggle.addEventListener("click", function () {
    list.hidden = !list.hidden;
    toggle.setAttribute("aria-expanded", String(!list.hidden));
  });
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data && event.data.type === "pending-changed") refresh();
  });
  refresh();
})();
