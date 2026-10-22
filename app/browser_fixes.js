// Small fixes for Streamlit's table editor, injected into the app page.
//
// 1. The table works out which cell is under the pointer when the pointer
//    moves. After the page scrolls or re-renders under a still pointer, the
//    first double-click lands on a stale cell and does nothing. After each
//    scroll, replay a pointer move at the pointer's position.
// 2. When a cell editor opens a second time, focus can stay on the table.
//    The first key then opens a fresh editor holding that key, and a one key
//    edit is never saved. Move focus into the editor as soon as it opens.
// 3. Warn before leaving the page when the event has unsaved changes.
// 4. Scroll to the part of the page an action changed.
//
// An earlier version also held Enter and Tab for 120 ms after a keystroke.
// That made fast typing worse: keys typed during the hold landed in the
// previous cell. The table keeps up on its own at 15 ms per key.
//
// This script runs in a small frame that Streamlit replaces on reruns, and
// the browser stops calling listeners that belong to a replaced frame. So
// the listeners are installed once into the main page as its own script,
// and each run only passes the current settings across.
(function () {
  const w = window.parent;
  const d = w.document;
  const cfg = window.ROTATION_CONFIG || {};

  function install(w, d) {
    w.__roFixesInstalled = true;
    w.__roDirty = false;
    w.__roScrollTo = (id) => {
      w.setTimeout(() => {
        const el = d.getElementById(id);
        if (el) el.scrollIntoView({behavior: "smooth", block: "start"});
      }, 250);
    };

    let last = null, timer = null;
    const remember = (e) => { last = {clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY}; };
    const replay = () => {
      if (!last) return;
      const t = d.elementFromPoint(last.clientX, last.clientY);
      if (!t || !t.closest('[data-testid="stDataFrame"]')) return;
      for (const type of ["pointermove", "mousemove"]) {
        const Ctor = type === "pointermove" ? w.PointerEvent : w.MouseEvent;
        t.dispatchEvent(new Ctor(type, {bubbles: true, cancelable: true, composed: true, view: w,
          pointerId: 1, pointerType: "mouse", isPrimary: true, ...last}));
      }
    };
    d.addEventListener("pointermove", (e) => { if (e.isTrusted) remember(e); }, true);
    d.addEventListener("wheel", remember, {capture: true, passive: true});
    d.addEventListener("scroll", () => { w.clearTimeout(timer); timer = w.setTimeout(replay, 80); }, true);

    // A double-click opens the editor with its text selected, so typing
    // replaces it. An editor opened by typing holds that first key, so the
    // cursor goes after it instead.
    let lastDouble = 0;
    d.addEventListener("dblclick", (e) => { if (e.isTrusted) lastDouble = w.performance.now(); }, true);
    const focusEditor = () => {
      const portal = d.getElementById("portal");
      const el = portal && portal.querySelector("textarea, input");
      if (!el || portal.contains(d.activeElement)) return;
      el.focus();
      if (w.performance.now() - lastDouble < 600) el.select();
      else if (typeof el.setSelectionRange === "function") el.setSelectionRange(el.value.length, el.value.length);
    };
    const watchPortal = () => {
      const portal = d.getElementById("portal");
      if (!portal) { w.setTimeout(watchPortal, 500); return; }
      new w.MutationObserver(() => w.setTimeout(focusEditor, 0)).observe(portal, {childList: true, subtree: true});
    };
    watchPortal();

    // The rules table is mostly dropdowns. The table opens a cell on its
    // second click; in the rules table, one click selects the cell and then
    // opens it as if Enter were pressed.
    let pending = null;
    d.addEventListener("click", (e) => {
      if (!e.isTrusted || e.detail !== 1) return;
      const grid = e.target.closest && e.target.closest('[class*="st-key-rules_"] [data-testid="stDataFrame"]');
      if (!grid) return;
      w.clearTimeout(pending);
      pending = w.setTimeout(() => {
        const portal = d.getElementById("portal");
        if (portal && portal.querySelector("textarea, input, [role='option'], [role='listbox']")) return;
        const t = d.activeElement;
        if (!t || !grid.contains(t)) return;
        t.dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true, composed: true}));
      }, 250);
    }, true);
    d.addEventListener("dblclick", () => w.clearTimeout(pending), true);

    w.addEventListener("beforeunload", (e) => {
      if (!w.__roDirty) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  if (!w.__roFixesInstalled) {
    const s = d.createElement("script");
    s.textContent = "(" + install.toString() + ")(window, document);";
    d.head.appendChild(s);
    // If the page blocks added scripts, install from this frame instead.
    if (!w.__roFixesInstalled) install(w, d);
  }
  w.__roDirty = !!cfg.dirty;
  if (cfg.scrollTo && w.__roScrollTo) w.__roScrollTo(String(cfg.scrollTo));
})();
