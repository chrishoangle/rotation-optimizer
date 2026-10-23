// The read-only page a volunteer opens from the coordinator's QR code.
// Everything it shows comes from the link itself.

import { h, replace } from "./dom";
import { Snapshot, decodeSnapshot } from "./share";

let snap: Snapshot;
let round = 1;
let query = "";

function who(x: [string, string, number[]]): string {
  return x[1] && x[1] !== x[0] ? `${x[1]} (${x[0]})` : x[0];
}

function render(): void {
  const app = document.getElementById("app")!;
  const s = snap;
  const rows = s.f.map(([table, fam, where], i) => {
    const host = s.h.find((x) => x[2][round - 1] === i);
    return h("li", { className: host ? "" : "empty" },
      h("span", { className: "tn" }, `Table ${table}`),
      h("span", { className: "fam" }, fam, where ? h("span", { className: "help" }, ` · ${where}`) : null),
      h("span", { className: "who" }, host ? who(host) : "No host"));
  });
  const q = query.trim().toLowerCase();
  const found = q.length < 2 ? [] : [
    ...s.h.filter((x) => who(x).toLowerCase().includes(q)).map((x) => h("div", { className: "found" }, h("strong", {}, who(x)),
      h("ul", {}, x[2].map((fi, k) => h("li", {}, `Round ${k + 1}: ` + (fi >= 0 ? `Table ${s.f[fi][0]} (${s.f[fi][1]})` + (s.f[fi][2] ? `, ${s.f[fi][2]}` : "") : "no table")))))),
    ...s.f.map((f, i) => [f, i] as const).filter(([f]) => f[1].toLowerCase().includes(q)).map(([f, i]) => h("div", { className: "found" }, h("strong", {}, `${f[1]}: Table ${f[0]}`),
      h("ul", {}, Array.from({ length: s.r }, (_, k) => { const host = s.h.find((x) => x[2][k] === i); return h("li", {}, `Round ${k + 1}: ${host ? who(host) : "no host"}`); })))),
  ];
  const search = h("input", { type: "search", value: query, placeholder: "Find an alum or a fam", "aria-label": "Find an alum or a fam" }) as HTMLInputElement;
  search.addEventListener("input", () => { query = search.value; render(); const el = document.querySelector<HTMLInputElement>('input[type="search"]'); el?.focus(); el?.setSelectionRange(query.length, query.length); });
  replace(app, h("main", { className: "night-mode" },
    h("div", { className: "night-bar" }, h("strong", {}, s.t), h("span", { className: "help" }, "Read only")),
    h("div", { className: "msg info" }, `Snapshot from ${s.at}. If the coordinator re-plans, ask for the new code.`),
    h("section", { className: "panel" }, search, found.length ? found : q.length >= 2 ? h("p", { className: "help" }, "No match.") : null),
    h("div", { className: "tabs", role: "tablist" }, Array.from({ length: s.r }, (_, k) =>
      h("button", { className: "tab", role: "tab", "aria-selected": round === k + 1 ? "true" : "false", onclick: () => { round = k + 1; render(); } }, `Round ${k + 1}`))),
    h("ul", { className: "now-list" }, rows)));
}

async function boot(): Promise<void> {
  const s = await decodeSnapshot(location.hash.slice(1));
  if (!s) {
    replace(document.getElementById("app")!, h("main", { className: "night-mode" },
      h("div", { className: "msg error" }, "This link is incomplete. Ask the coordinator to show the QR code again.")));
    return;
  }
  snap = s;
  round = Math.min(Math.max(1, s.c), s.r);
  document.title = `${s.t}: who is where`;
  render();
}

window.addEventListener("hashchange", boot);
boot();
