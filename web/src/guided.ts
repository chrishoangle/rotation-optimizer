// The guided planner: one step on screen at a time, in event words, for a
// coordinator who plans one dinner a year. It uses the same event, planner,
// and printouts as the full planner, which stays one click away under More.
//
//   Start, Event, Alumni, Fams, Schedule, Print, The night, Next year

import { h, openPage, readFile, replace } from "./dom";
import {
  EventState, FAM_COLUMNS, HOST_COLUMNS, applySpelling, checkInputs, famLocations, hasStarted, isCurrent, loadEvent, maxRounds,
  nearMisses, newEvent, normalizeState, normalizeTable, stepFreeFams,
} from "./event";
import { explainPairing, sharedPairings } from "./explain";
import { hostCardsHtml, runSheetHtml, seatingChartHtml, tableNumbers, tableTentsHtml } from "./export";
import { FIELDS } from "./forms";
import { movesBetween } from "./moves";
import { looksLikeHeader, parsePasted } from "./paste";
import { HostSettings, clearGrid, gridChanges, hostSettings, placeInGrid, renameInRules, setHostSettings, settingsWords } from "./people";
import type { EventPlan } from "./planning";
import { provenOptimal } from "./planning";
import {
  backupPacketHtml, coordinatorGuideHtml, hostBadgesHtml, planSummaryHtml, privacyNoteHtml, roleCardsHtml, runnerSheetsHtml,
} from "./printables";
import { csvRecords } from "./py";
import { CleanRow, dropExampleRows, groupStudentRows, matchColumns, renameColumns } from "./sheets";

/** What the guided pages need from the app around them. */
export interface GuidedCtx {
  get(): EventState;
  set(s: EventState): void;
  persist(): void;
  now(): string;
  /** Plan or update the schedule; returns a problem in plain words, or "" when it worked. */
  solve(keepPrinted: boolean): Promise<string>;
  openNight(): void;
  openFull(): void;
  practice(): void;
  inPractice(): boolean;
  practiceBanner(): HTMLElement | null;
  saveFile(): void;
  handOff(): void;
  markPrinted(): void;
  fileName(what: string, ext: string): string;
  tryExample(): void;
  removeStudentNames(): void;
  offlineCopy(): void;
}

const STEPS = ["Event", "Alumni", "Fams", "Schedule", "Print", "The night", "Next year"] as const;
const STEP_KEY = "rotation-optimizer:step";

let ctx: GuidedCtx;
let step = -1; // -1 is the start screen
let message: [string, string] | null = null; // [kind, text], shown once
let problems: string[] = [];
let picked: { round: number; famId: string } | null = null; // first cell tapped in the grid
let why: { round: number; famId: string } | null = null;
let openSettings: string | null = null;
let more = false;
let details = false;
let changed: string[] = []; // what the last update moved, in sentences
let printedNow = new Set<string>();
let showMoreColumns = false;
let busy = false;
let sure = false; // the second tap of a remove
let practiceReturn: number | null = null; // the step to come back to when practice ends

const ev = () => ctx.get();

function remember(): void {
  try { localStorage.setItem(STEP_KEY, String(step)); } catch { /* the step is only a convenience */ }
}

function go(n: number): void {
  step = n;
  changed = [];
  problems = [];
  picked = null;
  why = null;
  openSettings = null;
  more = false;
  remember();
  render();
  window.scrollTo(0, 0);
}

function say(kind: "ok" | "info" | "warn" | "error", text: string): void {
  message = [kind, text];
}

const hasPeople = (s: EventState) => s.hosts.some((r) => (r.table_label || r.host_name || "").trim()) || s.fams.some((r) => (r.fam_label || "").trim());

// ----------------------------------------------------------------------
// The frame: progress, saving, and More.
// ----------------------------------------------------------------------

function header(): HTMLElement {
  const s = ev();
  const reached = furthest();
  return h("header", { className: "g-head" },
    h("div", { className: "g-top" },
      h("strong", { className: "g-title" }, step >= 0 ? s.title || "Your event" : "Rotation Optimizer"),
      ctx.inPractice() || step >= 0 ? h("span", { className: "g-saved", title: "Everything is saved in this browser as you work." }, ctx.inPractice() ? "Practice: nothing is kept" : "Saved") : null,
      h("div", { className: "g-more" },
        h("button", { className: "button small", "aria-expanded": more ? "true" : "false", onclick: () => { more = !more; render(); } }, "More"),
        more ? h("div", { className: "g-menu", role: "menu" },
          h("button", { role: "menuitem", onclick: () => { more = false; ctx.saveFile(); say("ok", "A copy of your event was downloaded. Keep it somewhere safe, or open it on another computer."); render(); } }, "Download a copy of this event"),
          openFileItem(),
          h("button", { role: "menuitem", onclick: () => { more = false; go(-1); } }, "New event or example"),
          h("button", { role: "menuitem", onclick: () => openPage(coordinatorGuideHtml(s.title)) }, "Print the coordinator guide"),
          h("button", { role: "menuitem", onclick: () => { more = false; ctx.offlineCopy(); } }, "Download an offline copy of the app"),
          h("button", { role: "menuitem", onclick: () => ctx.openFull() }, "Full planner (every option)")) : null)),
    step >= 0 ? h("nav", { className: "g-steps", "aria-label": "Steps" }, STEPS.map((label, i) =>
      h("button", {
        className: `g-step ${i === step ? "now" : ""} ${i < reached ? "done" : ""}`, disabled: i > reached,
        "aria-current": i === step ? "step" : null, onclick: () => go(i),
      }, h("span", { className: "n" }, String(i + 1)), h("span", { className: "l" }, label)))) : null,
    ctx.practiceBanner());
}

function openFileItem(): HTMLElement {
  const input = h("input", { type: "file", accept: ".json,application/json", className: "visually-hidden", id: "g-open" }) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
      ctx.set(loadEvent(await readFile(f)));
      say("ok", `Opened ${f.name}.`);
      more = false;
      go(ev().plan ? 3 : 1);
    } catch {
      say("error", "That file is not a saved event. Choose a file you downloaded from this app.");
      render();
    }
  });
  return h("label", { role: "menuitem", htmlFor: "g-open", for: "g-open", className: "g-menu-label" }, input, "Open a saved event");
}

/** The furthest step the coordinator can go to now. */
function furthest(): number {
  const s = ev();
  if (!s.hosts.some((r) => (r.table_label || r.host_name || "").trim())) return 1;
  if (!s.fams.some((r) => (r.fam_label || "").trim())) return 2;
  if (!s.plan) return 3;
  return STEPS.length - 1;
}

function msg(): HTMLElement | null {
  if (!message) return null;
  const [kind, text] = message;
  message = null;
  return h("div", { className: `msg ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}

function nav(back: number | null, nextLabel: string | null, next: () => void, extra: HTMLElement | null = null): HTMLElement {
  return h("div", { className: "g-nav" },
    back !== null ? h("button", { className: "button", onclick: () => go(back) }, "Back") : h("span"),
    extra,
    nextLabel ? h("button", { className: "button primary big", disabled: busy, onclick: next }, nextLabel) : null);
}

// The More menu closes with a tap outside it or with Escape.
document.addEventListener("click", (e) => {
  if (more && !(e.target as HTMLElement).closest(".g-more")) { more = false; render(); }
});
document.addEventListener("keydown", (e) => {
  if (more && e.key === "Escape") { more = false; render(); }
});

export function renderGuided(c: GuidedCtx): void {
  ctx = c;
  if (practiceReturn !== null && !ctx.inPractice()) { step = practiceReturn; practiceReturn = null; remember(); }
  if (step === -1 && hasPeople(ev())) {
    try { const saved = Number(localStorage.getItem(STEP_KEY)); if (saved >= 0) step = Math.min(saved, furthest()); } catch { /* start screen */ }
  }
  render();
}

function render(): void {
  const app = document.getElementById("app")!;
  const body = step === -1 ? startPage() : [eventPage, alumniPage, famsPage, schedulePage, printPage, nightPage, nextYearPage][step]();
  replace(app, h("main", { className: "guided", id: "main" }, header(), msg(), body,
    h("footer", { className: "g-foot" }, "Everything stays in this browser and is saved as you work. Nothing is sent anywhere.")));
}

// ----------------------------------------------------------------------
// Start.
// ----------------------------------------------------------------------

function startPage(): HTMLElement {
  const s = ev();
  const going = hasPeople(s) && !ctx.inPractice();
  return h("section", { className: "g-page g-start" },
    h("h1", {}, "Plan a rotation dinner"),
    h("p", { className: "lead" }, "Students sit with their fam all night. Alumni move to a new table each round. This tool decides who goes where, prints everything for the night, and helps when someone cancels."),
    h("div", { className: "g-choices" },
      going ? h("button", { className: "g-choice primary", onclick: () => go(Math.min(furthest(), 3)) },
        h("strong", {}, `Continue ${s.title || "your event"}`), h("span", {}, `${s.hosts.length} alumni, ${s.fams.length} fams`)) : null,
      h("button", { className: "g-choice", onclick: () => {
        ctx.set(newEvent({ title: "", rounds: 2 }));
        go(0);
      } }, h("strong", {}, "New event"), h("span", {}, going ? "Your current event is kept in this browser's earlier versions." : "Start from an empty event.")),
      h("label", { className: "g-choice", htmlFor: "g-open-start", for: "g-open-start" }, startOpenInput(),
        h("strong", {}, "Open a saved event"), h("span", {}, "A file you downloaded, or last year's hand-off.")),
      h("button", { className: "g-choice", onclick: async () => { practiceReturn = -1; ctx.tryExample(); go(3); await update(); } },
        h("strong", {}, "Try it with an example"), h("span", {}, "A practice dinner with 10 alumni and 10 fams. Nothing you do is kept."))));
}

function startOpenInput(): HTMLElement {
  const input = h("input", { type: "file", accept: ".json,application/json", className: "visually-hidden", id: "g-open-start" }) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
      ctx.set(loadEvent(await readFile(f)));
      say("ok", `Opened ${f.name}.`);
      go(ev().plan ? 3 : 1);
    } catch {
      say("error", "That file is not a saved event. Choose a file you downloaded from this app.");
      render();
    }
  });
  return input;
}

// ----------------------------------------------------------------------
// Event.
// ----------------------------------------------------------------------

function eventPage(): HTMLElement {
  const s = ev();
  const name = h("input", { type: "text", value: s.title, placeholder: "For example: Transfer Admit Dinner 2026", "aria-label": "Event name" }) as HTMLInputElement;
  name.addEventListener("input", () => { s.title = name.value; ctx.persist(); });
  const rounds = h("select", { "aria-label": "Rounds" }, [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: n, selected: n === s.rounds }, `${n} round${n !== 1 ? "s" : ""}`))) as HTMLSelectElement;
  rounds.addEventListener("change", () => { s.rounds = Number(rounds.value); s.finished = Math.min(s.finished, s.rounds - 1); ctx.persist(); });
  const doors = h("input", { type: "text", value: s.startTime, placeholder: "6:30 PM", "aria-label": "Doors open at" }) as HTMLInputElement;
  doors.addEventListener("input", () => { s.startTime = doors.value; ctx.persist(); });
  const date = h("input", { type: "date", value: s.night.date ?? "", "aria-label": "Date of the event" }) as HTMLInputElement;
  date.addEventListener("change", () => { s.night = { ...s.night, date: date.value }; ctx.persist(); });
  const minutes = h("select", { "aria-label": "Minutes per round" }, [10, 15, 20, 25, 30, 40].map((n) => h("option", { value: n, selected: n === s.roundMinutes }, `${n} minutes`))) as HTMLSelectElement;
  minutes.addEventListener("change", () => { s.roundMinutes = Number(minutes.value); ctx.persist(); });
  return h("section", { className: "g-page" },
    h("h1", {}, "Your event"),
    h("div", { className: "g-form" },
      field("Event name", name),
      field("How many rounds?", rounds, "Each round, every alum sits with a different fam."),
      field("Date", date, "Optional. On the day, night mode tells you if you are running late."),
      field("Doors open at", doors, "Optional. Used for the run sheet and the clock on the night."),
      field("Each round lasts", minutes)),
    nav(-1, "Next: alumni", () => {
      if (!s.title.trim()) s.title = "Alumni dinner";
      ctx.persist();
      go(1);
    }));
}

function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  return h("label", { className: "field" }, h("span", { className: "label" }, label), input, help ? h("span", { className: "help" }, help) : null);
}

// ----------------------------------------------------------------------
// Alumni and fams: one list each, typed, pasted, or uploaded.
// ----------------------------------------------------------------------

interface Col { key: string; label: string; placeholder: string; wide?: boolean }

const ALUMNI: Col[] = [
  { key: "host_name", label: "Alum's name", placeholder: "e.g. Sam Rivera" },
  { key: "table_label", label: "Topic (optional)", placeholder: "e.g. Pharmacy" },
  { key: "tags", label: "Can talk about", placeholder: "pharmacy; healthcare; business", wide: true },
];
const FAMS: Col[] = [
  { key: "table_number", label: "Table", placeholder: "1" },
  { key: "fam_label", label: "Fam name", placeholder: "Fam Red" },
  { key: "interests", label: "Interested in", placeholder: "biology; pre-med", wide: true },
  { key: "students", label: "Students (optional)", placeholder: "Student 01; Student 02", wide: true },
];
const FAM_EXTRA: Col[] = [
  { key: "size", label: "How many students", placeholder: "6" },
  { key: "location", label: "Where in the room", placeholder: "by the stage" },
  { key: "step_free", label: "Step-free?", placeholder: "yes" },
];

function peopleList(kind: "hosts" | "fams", cols: Col[]): HTMLElement {
  const s = ev();
  const rows = () => (kind === "hosts" ? s.hosts : s.fams);
  const ensure = () => { normalizeState(s); };
  const list = h("div", { className: "g-list", "data-kind": kind });
  const draw = () => {
    const all = rows();
    replace(list,
      h("div", { className: "g-row g-row-head" }, cols.map((c) => h("span", { className: c.wide ? "wide" : "" }, c.label)), h("span", { className: "g-x" })),
      [...all, null].map((row, i) => {
        const r = row ?? {} as CleanRow;
        const cells = cols.map((c) => {
          const input = h("input", { type: "text", value: r[c.key] ?? "", placeholder: row ? "" : c.placeholder, "aria-label": `${c.label}, row ${i + 1}`, className: c.wide ? "wide" : "", "data-col": c.key }) as HTMLInputElement;
          const before = r[c.key] ?? "";
          input.addEventListener("input", () => {
            if (!row) {
              const blank: CleanRow = Object.fromEntries((kind === "hosts" ? HOST_COLUMNS : FAM_COLUMNS).map((k) => [k, ""]));
              blank[c.key] = input.value;
              rows().push(blank);
              ensure();
              ctx.persist();
              draw();
              const again = list.querySelectorAll<HTMLInputElement>(`.g-row:not(.g-row-head)`)[i]?.querySelector<HTMLInputElement>(`[data-col="${c.key}"]`);
              again?.focus();
              again?.setSelectionRange(again.value.length, again.value.length);
              return;
            }
            r[c.key] = input.value;
            ctx.persist();
          });
          input.addEventListener("change", () => {
            if (row && (c.key === "table_label" || c.key === "fam_label")) renameInRules(s, kind === "hosts" ? "host" : "fam", before, input.value);
            ctx.persist();
          });
          input.addEventListener("paste", (e) => {
            const grid = parsePasted((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
            if (!grid) return;
            e.preventDefault();
            say("ok", pasteInto(kind, cols, grid, i, cols.indexOf(c)));
            render();
          });
          input.addEventListener("keydown", (e) => {
            if ((e as KeyboardEvent).key !== "Enter") return;
            e.preventDefault();
            const next = list.querySelectorAll<HTMLElement>(`.g-row:not(.g-row-head)`)[i + 1]?.querySelector<HTMLInputElement>(`[data-col="${c.key}"]`);
            next?.focus();
          });
          return input;
        });
        const extra = kind === "hosts" && row ? settingsButton(row) : null;
        return [
          h("div", { className: `g-row ${row ? "" : "new"}` }, cells,
            row ? h("button", { className: "button icon g-x", title: "Remove", tabindex: -1, "aria-label": `Remove row ${i + 1}`, onclick: () => {
              rows().splice(i, 1);
              ctx.persist();
              draw();
            } }, "×") : h("span", { className: "g-x" })),
          extra,
          kind === "hosts" && row && openSettings === row.host_id ? settingsPanel(row) : null,
        ];
      }));
  };
  draw();
  return list;
}

function pasteInto(kind: "hosts" | "fams", cols: Col[], grid: string[][], startRow: number, startCol: number): string {
  const s = ev();
  const list = kind === "hosts" ? s.hosts : s.fams;
  const mapping = matchColumns(grid[0], kind);
  const required = kind === "hosts" ? "table_label" : "fam_label";
  const byHeader = looksLikeHeader(grid[0]) && (required in mapping || "host_name" in mapping);
  const body = byHeader ? grid.slice(1) : grid;
  const blank = (): CleanRow => Object.fromEntries((kind === "hosts" ? HOST_COLUMNS : FAM_COLUMNS).map((k) => [k, ""]));
  const first = byHeader ? Math.min(startRow, list.length) : startRow;
  body.forEach((cells, k) => {
    while (list.length <= first + k) list.push(blank());
    const row = list[first + k];
    if (byHeader) for (const [ours, theirs] of Object.entries(mapping)) row[ours] = cells[grid[0].indexOf(theirs)] ?? "";
    else cells.forEach((v, j) => { const col = cols[startCol + j]; if (col) row[col.key] = v; });
  });
  normalizeState(s);
  ctx.persist();
  const noun = kind === "hosts" ? "alum" : "fam";
  return `Added ${body.length} ${noun}${body.length !== 1 ? (kind === "hosts" ? "ni" : "s") : ""} from your spreadsheet.`;
}

function uploadButton(kind: "hosts" | "fams"): HTMLElement {
  const id = `g-up-${kind}`;
  const input = h("input", { type: "file", accept: ".csv,text/csv", className: "visually-hidden", id }) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    const { rows, columns } = csvRecords(await readFile(f));
    const mapping = matchColumns(columns, kind);
    const required = kind === "hosts" ? "table_label" : "fam_label";
    if (!(required in mapping) && !(kind === "hosts" && "host_name" in mapping)) {
      say("error", `Could not tell which column holds the ${kind === "hosts" ? "alumni" : "fam names"}. Columns found: ${columns.join(", ")}. Rename that column to ${kind === "hosts" ? "Alum's name" : "Fam name"} and upload again, or paste the rows instead.`);
      render();
      return;
    }
    let clean = renameColumns(rows, mapping).filter((r) => Object.values(r).some((v) => (v || "").trim()));
    [clean] = dropExampleRows(clean);
    let grouped = 0;
    if (kind === "fams") [clean, grouped] = groupStudentRows(clean);
    const s = ev();
    if (kind === "hosts") s.hosts = normalizeTable(clean, HOST_COLUMNS, "host_id", "h");
    else s.fams = normalizeTable(clean, FAM_COLUMNS, "fam_id", "fam_");
    ctx.persist();
    say("ok", `Read ${clean.length} ${kind === "hosts" ? "alumni" : "fams"} from ${f.name}` + (grouped ? `, grouping ${grouped} student answers by fam.` : ".") + " Email and phone columns are never kept.");
    render();
  });
  return h("label", { className: "button", htmlFor: id, for: id }, input, "Upload a spreadsheet file");
}

function settingsButton(row: CleanRow): HTMLElement {
  const words = settingsWords(ev(), row.host_id);
  const isOpen = openSettings === row.host_id;
  return h("div", { className: "g-settings-line" },
    words.length ? h("span", { className: "g-tags" }, words.map((w) => h("span", { className: "g-tag" }, w))) : null,
    h("button", { className: "button link", "aria-expanded": isOpen ? "true" : "false", onclick: () => { openSettings = isOpen ? null : row.host_id; render(); } },
      isOpen ? "Done" : words.length ? "Change" : "Arrives late, can't use stairs…"));
}

function settingsPanel(row: CleanRow): HTMLElement {
  const s = ev();
  const n = s.rounds;
  const x = hostSettings(s, row.host_id);
  const save = (next: Partial<HostSettings>) => { setHostSettings(s, row.host_id, { ...hostSettings(s, row.host_id), ...next }); ctx.persist(); render(); };
  const roundSel = (label: string, value: number, onPick: (v: number) => void) => {
    const sel = h("select", { "aria-label": label }, Array.from({ length: n }, (_, k) => h("option", { value: k + 1, selected: k + 1 === value }, `round ${k + 1}`))) as HTMLSelectElement;
    sel.addEventListener("change", () => onPick(Number(sel.value)));
    return sel;
  };
  const check = (label: string, on: boolean, onPick: (v: boolean) => void, help: string) => {
    const box = h("input", { type: "checkbox", checked: on }) as HTMLInputElement;
    box.addEventListener("change", () => onPick(box.checked));
    return h("label", { className: "check" }, box, ` ${label}`, h("span", { className: "help" }, ` ${help}`));
  };
  const famNames = s.fams.map((r) => r.fam_label).filter((f) => f.trim());
  const famPick = (label: string, chosen: string[], onPick: (v: string[]) => void) => {
    const sel = h("select", { "aria-label": label }, h("option", { value: "" }, "Add a fam…"), famNames.filter((f) => !chosen.includes(f)).map((f) => h("option", { value: f }, f))) as HTMLSelectElement;
    sel.addEventListener("change", () => { if (sel.value) onPick([...chosen, sel.value]); });
    return h("div", { className: "row" }, h("span", {}, label), chosen.map((f) => h("button", { className: "button small", title: "Remove", onclick: () => onPick(chosen.filter((y) => y !== f)) }, `${f} ×`)), famNames.length ? sel : h("span", { className: "help" }, "Add fams first."));
  };
  return h("div", { className: "g-settings panel" },
    h("div", { className: "row" }, h("span", {}, "Hosts from"), roundSel("Hosts from round", x.from, (v) => save({ from: v, until: Math.max(v, x.until) })),
      h("span", {}, "to"), roundSel("Hosts until round", x.until, (v) => save({ until: v, from: Math.min(v, x.from) }))),
    check("Stays at one table all night", x.stays, (v) => save({ stays: v }), "For someone who can't move between tables. The tool picks the best fam."),
    check("Can't use stairs", x.stepFree, (v) => save({ stepFree: v }), "Only visits tables marked step-free in the Fams step."),
    famPick("Must meet", x.must, (v) => save({ must: v })),
    famPick("Never meets", x.never, (v) => save({ never: v })));
}

function alumniPage(): HTMLElement {
  const s = ev();
  return h("section", { className: "g-page" },
    h("h1", {}, "Alumni"),
    h("p", { className: "lead" }, "One row per alum: their name, an optional topic for the signs (their name is used if you leave it blank), and what they can talk about, separated by semicolons. Type here, or copy rows from your spreadsheet and paste them into the first box."),
    h("div", { className: "row" }, uploadButton("hosts"), fieldsHelp()),
    problemsBox(),
    peopleList("hosts", ALUMNI),
    nav(0, "Next: fams", () => {
      for (const r of s.hosts) if (!(r.table_label ?? "").trim() && (r.host_name ?? "").trim()) r.table_label = r.host_name.trim();
      normalizeState(s);
      const inputs = checkInputs({ ...s, fams: s.fams.length ? s.fams : [{ fam_id: "x", fam_label: "x" }], rules: [] });
      problems = inputs.problems.filter((p) => !/fam/i.test(p));
      if (!s.hosts.length) problems = ["Add at least one alum."];
      if (problems.length) { render(); return; }
      ctx.persist();
      go(2);
    }));
}

function famsPage(): HTMLElement {
  const s = ev();
  return h("section", { className: "g-page" },
    h("h1", {}, "Fams"),
    h("p", { className: "lead" }, "One row per fam: the table number they will sit at, the fam's name, and what its students are interested in. Student names are optional; they print a find-your-table page."),
    h("div", { className: "row" }, uploadButton("fams"), fieldsHelp(),
      h("button", { className: "button link", onclick: () => { showMoreColumns = !showMoreColumns; render(); } }, showMoreColumns ? "Fewer columns" : "More columns: size, where in the room, step-free")),
    problemsBox(),
    peopleList("fams", showMoreColumns ? [...FAMS, ...FAM_EXTRA] : FAMS),
    nav(1, "Make the schedule", async () => {
      normalizeState(s);
      problems = checkInputs({ ...s, rules: [] }).problems;
      if (!s.fams.length) problems = ["Add at least one fam."];
      if (s.rounds > maxRounds(s)) problems.push(`With ${s.hosts.length} alumni and ${s.fams.length} fams, the most rounds without a repeat is ${maxRounds(s)}. Lower the rounds in the Event step.`);
      if (problems.length) { render(); return; }
      go(3);
      await update();
    }));
}

function fieldsHelp(): HTMLElement {
  return h("details", { className: "g-fields" }, h("summary", {}, "Suggested interests"),
    h("p", { className: "help" }, "Alumni and fams match on the same words, so use the same words on both sides, for example: " + FIELDS.map((f) => f.toLowerCase()).join(", ") + "."));
}

function problemsBox(): HTMLElement | null {
  if (!problems.length) return null;
  return h("div", { className: "msg error", role: "alert" }, h("strong", {}, "Before going on:"), h("ul", {}, problems.map((p) => h("li", {}, plain(p)))));
}

/** The planner's words, in a coordinator's. */
function plain(text: string): string {
  return text.replace(/host tables?/g, (m) => (m.endsWith("s") ? "alumni" : "alum")).replace(/\bHost tables?\b/g, (m) => (m.endsWith("s") ? "Alumni" : "Alum"))
    .replace(/\btags?\b/g, "interests").replace(/\bhosts\b/g, "alumni").replace(/\bhost\b/g, "alum")
    .replace(/Pairing rule \d+: /, "").replace(/pairing rule/g, "setting").replace(/\b([Aa]) alum/g, "$1n alum");
}

/** A planner warning in a coordinator's words, for Things to look at and Details. */
function warningWords(w: string): string {
  if (w.startsWith("Host tags that no fam lists") || w.startsWith("Fam interests that no host lists")) {
    const list = w.slice(w.indexOf(": ") + 2).replace(/\.$/, "");
    return w.startsWith("Host") ? `No fam is interested in: ${list}.` : `No alum talks about: ${list}.`;
  }
  return plain(w.replace(/^Fairness check: /, ""))
    .replace(/gets no alum or a 0-score alum in (\d) rounds/, "has no alum, or one with nothing in common, in $1 rounds")
    .replace(/, no shared interests/g, ", nothing in common")
    .replace(/ Consider a must meet rule for this fam\./, "").replace(/ or turn on "No fam gets more than one weak round"/, "")
    .replace(/scores (\d+) in total, far below the typical fam \((\d+)\)\./, "matches its alumni much less than the other fams do.");
}

// ----------------------------------------------------------------------
// Schedule: one grid, tap two names to swap them.
// ----------------------------------------------------------------------

async function update(keepAll = false): Promise<void> {
  const s = ev();
  const before = s.plan;
  busy = true;
  render();
  const err = await ctx.solve(keepAll || hasStarted(s) || s.printed !== null);
  busy = false;
  if (err) {
    say("error", plain(err));
  } else if (before && s.plan) {
    const m = movesBetween(before, s.plan, s.finished + 1);
    changed = m.hosts.map((x) => x.text);
  } else changed = [];
  render();
}

function schedulePage(): HTMLElement {
  const s = ev();
  const p = s.plan;
  if (busy) return h("section", { className: "g-page" }, h("h1", {}, "Schedule"), h("p", { className: "lead" }, h("span", { className: "spinner" }), " Working out the best schedule…"));
  if (!p) return h("section", { className: "g-page" }, h("h1", {}, "Schedule"), h("button", { className: "button primary big", onclick: () => update() }, "Make the schedule"));
  const current = isCurrent(s);
  const [shared, all] = sharedPairings(p);
  const look = thingsToLookAt(p);
  const grid = gridView(p, current);
  const mine = gridChanges(s);
  return h("section", { className: "g-page" },
    h("h1", {}, "Schedule"),
    current ? null : h("div", { className: "msg warn row spread" }, "You changed something since this schedule was made.",
      h("button", { className: "button primary", disabled: busy, onclick: () => update() }, "Update the schedule")),
    h("p", { className: "g-headline" }, h("strong", {}, `${shared} of ${all}`), " pairings share an interest. No fam meets the same alum twice."),
    changed.length ? h("div", { className: "msg info" }, h("strong", {}, `Updated: ${changed.length} change${changed.length !== 1 ? "s" : ""}. `), changed.slice(0, 4).join(" "),
      changed.length > 4 ? h("details", {}, h("summary", {}, `${changed.length - 4} more`), changed.slice(4).map((c) => h("p", {}, c))) : null) : null,
    look.length ? h("div", { className: "g-look" }, h("h2", {}, "Things to look at"), look.slice(0, 3),
      look.length > 3 ? h("details", {}, h("summary", {}, `${look.length - 3} more`), look.slice(3)) : null) : null,
    h("p", { className: "help" }, current ? (picked ? h("strong", {}, `Now tap where they should go in round ${picked.round}. Tap them again to cancel.`) : "To move someone, tap their name, then tap where they should go in the same round. Everything else stays as it is where possible.") : "Update the schedule first, then you can move people."),
    h("p", { className: "help g-swipe" }, "Swipe the schedule sideways to see every round."),
    grid,
    why ? whyBox(p) : null,
    mine.length ? h("div", { className: "g-mine" }, `${mine.length} alum${mine.length !== 1 ? "ni" : ""} placed by hand. `,
      h("button", { className: "button link", onclick: async () => { clearGrid(s); ctx.persist(); await update(); } }, "Undo my moves")) : null,
    h("details", { className: "g-details", open: details, ontoggle: (e: Event) => { details = (e.target as HTMLDetailsElement).open; } },
      h("summary", {}, "Details"),
      h("p", {}, provenOptimal(p) ? (p.keptSlots !== null
        ? "This is the best update: every fam's night stays as fair as it can be, and as little as possible of what you printed changes."
        : "This is the best possible schedule for these people and settings: no other one gives more shared interests.") : "The tool stopped before checking every possible schedule."),
      p.warnings.length ? h("ul", {}, p.warnings.map((w) => h("li", {}, warningWords(w)))) : null),
    nav(2, current ? "Next: print" : null, () => go(4)));
}

function gridView(p: EventPlan, current: boolean): HTMLElement {
  const s = ev();
  const tables = tableNumbers(p);
  const fams = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const rounds = Array.from({ length: p.rounds }, (_, k) => k + 1);
  const locked = new Set(p.lockedRounds);
  const cell = (r: number, famId: string) => {
    const a = p.assignments.find((x) => x.round === r && x.groupId === famId);
    const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
    const gone = (p.famAway[famId] ?? []).includes(r);
    const isPicked = picked?.round === r && picked.famId === famId;
    const can = current && !locked.has(r) && r > s.finished && !gone && !busy;
    const label = gone ? "Fam not here" : host ? (host.person || host.name) : "No alum";
    const td = h("td", {
      className: `g-cell ${a && a.score === 0 ? "weak" : ""} ${!host ? "empty" : ""} ${isPicked ? "picked" : ""} ${can ? "can" : ""}`,
      draggable: can && !!host ? "true" : null,
    },
    h("button", { className: "g-name", disabled: !can, "aria-pressed": isPicked ? "true" : "false", onclick: () => tapCell(p, r, famId) }, label),
    host && host.person && host.person !== host.name ? h("span", { className: "g-sub" }, host.name) : null,
    a && a.score === 0 ? h("span", { className: "g-sub warn-text" }, "nothing in common") : null,
    h("button", { className: "g-why", title: "Why this pairing?", "aria-label": `Why ${label} at ${p.fams.find((f) => f.groupId === famId)!.name} in round ${r}`, onclick: () => { why = why?.round === r && why.famId === famId ? null : { round: r, famId }; render(); } }, "?"));
    if (can) {
      td.addEventListener("dragstart", (e) => { picked = { round: r, famId }; (e as DragEvent).dataTransfer?.setData("text/plain", famId); });
      td.addEventListener("dragover", (e) => { if (picked?.round === r) e.preventDefault(); });
      td.addEventListener("drop", (e) => { e.preventDefault(); tapCell(p, r, famId); });
    }
    return td;
  };
  const out = (r: number) => p.hosts.filter((x) => !p.assignments.some((a) => a.round === r && a.hostId === x.hostId)).map((x) => {
    const who = x.person || x.name;
    if ((p.hostAway[x.hostId] ?? []).includes(r)) return `${who} (cancelled)`;
    if ((p.hostLimits[x.hostId] ?? []).includes(r)) return `${who} (not here this round)`;
    return `${who} (break)`;
  });
  const anyOut = rounds.some((r) => out(r).length);
  return h("div", { className: "scroll" }, h("table", { className: "g-grid" },
    h("thead", {}, h("tr", {}, h("th", {}, "Table"), rounds.map((r) => h("th", {}, `Round ${r}` + (locked.has(r) || r <= s.finished ? " (done)" : ""))))),
    h("tbody", {}, fams.map((f) => h("tr", {}, h("th", { scope: "row" }, h("span", { className: "tn" }, `${tables[f.groupId]}`), " ", f.name), rounds.map((r) => cell(r, f.groupId))))),
    anyOut ? h("tfoot", {}, h("tr", {}, h("th", { scope: "row" }, "Not at a table"), rounds.map((r) => h("td", { className: "g-out" }, out(r).join(", ") || "Everyone hosts")))) : null));
}

async function tapCell(p: EventPlan, r: number, famId: string): Promise<void> {
  if (!picked || picked.round !== r) { picked = { round: r, famId }; render(); return; }
  if (picked.famId === famId) { picked = null; render(); return; }
  const picked0 = picked.famId;
  const s = ev();
  const rulesBefore = structuredClone(s.rules);
  const a = p.assignments.find((x) => x.round === r && x.groupId === picked!.famId);
  const b = p.assignments.find((x) => x.round === r && x.groupId === famId);
  const famA = p.fams.find((f) => f.groupId === picked!.famId)!.name, famB = p.fams.find((f) => f.groupId === famId)!.name;
  const nameOf = (id: string) => p.hosts.find((x) => x.hostId === id)!.name;
  if (a) placeInGrid(s, nameOf(a.hostId), famB, r);
  if (b) placeInGrid(s, nameOf(b.hostId), famA, r);
  picked = null;
  ctx.persist();
  await update(true);
  if (isCurrent(s) && changed.length) {
    const elsewhere = changed.filter((c) => !c.includes(`in round ${r},`)).length;
    if (elsewhere) changed = [...changed.filter((c) => c.includes(`in round ${r},`)), `To keep every fam from meeting the same alum twice, ${elsewhere} change${elsewhere !== 1 ? "s were" : " was"} also needed in other rounds:`, ...changed.filter((c) => !c.includes(`in round ${r},`))];
  }
  if (!isCurrent(s)) {
    // The swap broke a setting: put everything back as it was.
    s.rules = rulesBefore;
    ctx.persist();
    const moves: [string, string][] = [];
    if (a) moves.push([a.hostId, famId]);
    if (b) moves.push([b.hostId, picked0]);
    message = ["error", `${refusal(p, r, moves)} Nothing was changed.`];
    changed = [];
    render();
  }
}

/** Why a hand move was refused, naming the setting when one alum's settings rule it out. */
function refusal(p: EventPlan, r: number, moves: [string, string][]): string {
  const s = ev();
  const free = new Set(stepFreeFams(s));
  for (const [hostId, famId] of moves) {
    const host = p.hosts.find((x) => x.hostId === hostId)!;
    const fam = p.fams.find((f) => f.groupId === famId)!;
    const who = host.person || host.name;
    const x = hostSettings(s, hostId);
    if (r < x.from || r > x.until) return `${who} isn't there in round ${r}.`;
    if (x.stepFree && !free.has(famId)) return `${who} can't use stairs, and ${fam.name}'s table isn't step-free.`;
    if (x.stays) return `${who} stays at one table all night.`;
    if (x.never.some((n) => n.toLowerCase() === fam.name.toLowerCase())) return `${who} is set to never meet ${fam.name}.`;
  }
  return "That move doesn't fit: no schedule keeps everyone's settings (arrival time, stairs, must or never meet) with it while no fam meets the same alum twice.";
}

function whyBox(p: EventPlan): HTMLElement {
  const x = explainPairing(p, why!.round, why!.famId);
  const s = ev();
  const limited = (label: string) => s.rules.some((r) => (r.host_table ?? "").toLowerCase() === label.toLowerCase() && ["needs step-free", "stays with", "never meet"].includes(r.rule));
  const lines = x.lines.filter((l) => {
    if (l.startsWith("The schedule maximizes")) return false;
    const m = l.match(/^The best match for .+ is (.+?) \(score/);
    return !(m && limited(m[1]));
  });
  const fam = p.fams.find((f) => f.groupId === why!.famId)!;
  const seated = p.assignments.find((a) => a.round === why!.round && a.groupId === why!.famId)?.hostId;
  const stepFree = stepFreeFams(s).includes(why!.famId);
  const reasons: string[] = [];
  for (const r of s.rules) {
    const who = s.hosts.find((x) => (x.table_label ?? "").toLowerCase() === (r.host_table ?? "").toLowerCase());
    if (!who || who.host_id === seated) continue;
    if (r.rule === "needs step-free" && stepFree) continue;
    const name = who.host_name || who.table_label;
    const shares = (who.tags ?? "").toLowerCase().split(/[;,]/).map((t) => t.trim()).some((t) => t && fam.interests.includes(t));
    if (!shares) continue;
    if (r.rule === "needs step-free") reasons.push(`${name} would be a good match but can't use stairs, so only visits step-free tables.`);
    else if (r.rule === "stays with") reasons.push(`${name} would be a good match but stays at one table all night.`);
    else if (r.rule === "never meet" && (r.fam ?? "").toLowerCase() === fam.name.toLowerCase()) reasons.push(`${name} would be a good match but is set to never meet ${fam.name}.`);
  }
  return h("div", { className: "panel g-why-box" }, h("strong", {}, `Round ${why!.round}, ${p.fams.find((f) => f.groupId === why!.famId)!.name}`),
    lines.map((l) => h("p", {}, plain(l.replace(/ \(score \d+\)/, "").replace(/, so the pairing scores \d+\./, ".").replace(/ shares none of (.+)'s fields, so the pairing scores 0\./, " has nothing in common with $1.")
      .replace(/ shares none of (.+)'s interests, so the pairing scores 0\./, " has nothing in common with $1.")))),
    reasons.map((x) => h("p", {}, x)),
    lines.some((l) => l.startsWith("The best match")) ? h("p", { className: "help" }, "The schedule balances every fam at once, so a fam sometimes gets its second choice. To change it, tap names in the grid.") : null,
    h("button", { className: "button small", onclick: () => { why = null; render(); } }, "Close"));
}

function thingsToLookAt(p: EventPlan): HTMLElement[] {
  const s = ev();
  const out: HTMLElement[] = [];
  for (const m of nearMisses(s.hosts, s.fams)) {
    out.push(h("div", { className: "g-item" }, `${m.spellings.join(" and ")} look like the same interest, but only exact words match.`,
      h("button", { className: "button small primary", onclick: async () => { applySpelling(s, m); ctx.persist(); await update(); } }, `Use "${m.suggestion}" for all`)));
  }
  const free = stepFreeFams(s);
  for (const [hostId, rs] of Object.entries(p.hostBreaks)) {
    const x = hostSettings(s, hostId);
    if (!x.stepFree) continue;
    const who = p.hosts.find((h) => h.hostId === hostId)!;
    const sitOut = rs.filter((r) => r >= x.from && r <= x.until && !(p.hostAway[hostId] ?? []).includes(r));
    if (!sitOut.length) continue;
    out.push(h("div", { className: "g-item" },
      `${who.person || who.name} sits out round${sitOut.length !== 1 ? "s" : ""} ${sitOut.join(" and ")}: they can't use stairs, and only ${free.length} table${free.length !== 1 ? "s are" : " is"} step-free, so they can visit ${free.length !== 1 ? "each" : "it"} once.`,
      h("button", { className: "button small", onclick: () => go(2) }, "Mark more tables step-free")));
  }
  const fair = p.warnings.filter((x) => x.startsWith("Fairness check"));
  const shared = (w: string) => warningWords(w).match(/ There are more fams than .+$/)?.[0] ?? "";
  for (const w of fair) out.push(h("div", { className: "g-item" }, warningWords(w).replace(shared(w), "")));
  if (fair.length) {
    const why = fair.map(shared).find((x) => x);
    out.push(h("p", { className: "help" }, why ? why.trim() : "To fix it, tap a name in the grid and swap in an alum who shares an interest."));
  }
  for (const w of p.warnings.filter((x) => x.startsWith("Host tags that no fam lists") || x.startsWith("Fam interests that no host lists"))) {
    out.push(h("div", { className: "g-item" }, warningWords(w),
      h("button", { className: "button small", onclick: () => go(w.startsWith("Host") ? 1 : 2) }, "Edit interests")));
  }
  return out;
}

// ----------------------------------------------------------------------
// Print.
// ----------------------------------------------------------------------

function printPage(): HTMLElement {
  const s = ev();
  const p = s.plan!;
  const loc = famLocations(s);
  const main: [string, string, () => string][] = [
    ["Seating chart", "Big list for the room: who is at each table, each round.", () => seatingChartHtml(p, s.title, null, true, "", loc)],
    ["Host cards", "Half a page per alum: where to go each round and what to talk about.", () => hostCardsHtml(p, null, s.title, "", loc)],
    ["Table tents", "A big number to stand on each fam's table.", () => tableTentsHtml(p)],
    ["Run sheet", "For you and the MC: the timeline and check-in lists.", () => runSheetHtml(p, s.title, s.startTime, s.roundMinutes)],
  ];
  const extra: [string, string, () => string][] = [
    ["Backup packet", "The whole night on paper, in case every device fails.", () => backupPacketHtml(p, s.title, s.printedAt)],
    ["Host badges", "A card with each alum's tables, to slip behind a name badge.", () => hostBadgesHtml(p, s.title, loc)],
    ["Runner sheets", "For two volunteers: who arrives at their tables each round.", () => runnerSheetsHtml(p, s.title, 2, loc)],
    ["Volunteer role cards", "Door, runner, MC, floater.", () => roleCardsHtml(s.title)],
    ["Plan summary", "For a director.", () => planSummaryHtml(p, s.title, [], s.notes)],
    ["Privacy note", "For IT or a supervisor.", () => privacyNoteHtml()],
  ];
  const item = ([label, help, make]: [string, string, () => string], isMain: boolean) => h("li", { className: printedNow.has(label) ? "done" : "" },
    h("button", { className: `button ${isMain && !printedNow.has(label) ? "primary" : ""}`, onclick: () => {
      openPage(make());
      printedNow.add(label);
      if (isMain && !s.printed) { ctx.markPrinted(); say("ok", "Recorded what you printed. If anything changes later, the tool lists exactly what to reprint."); }
      render();
    } }, printedNow.has(label) ? "Opened ✓" : "Open and print"),
    h("span", {}, h("strong", {}, label), h("span", { className: "help" }, ` ${help}`)));
  return h("section", { className: "g-page" },
    h("h1", {}, "Print"),
    h("p", { className: "lead" }, "Open each page and print it from your browser on US Letter."),
    h("ul", { className: "g-print" }, main.map((x) => item(x, true))),
    h("details", { className: "g-details" }, h("summary", {}, "More pages for your team"), h("ul", { className: "g-print" }, extra.map((x) => item(x, false)))),
    s.printed ? h("p", { className: "help" }, `Printed version recorded${s.printedAt ? ` at ${s.printedAt}` : ""}. For a backup on another device, use More, Download a copy of this event.`) : null,
    nav(3, "Next: the night", () => go(5)));
}

// ----------------------------------------------------------------------
// The night and next year.
// ----------------------------------------------------------------------

function nightPage(): HTMLElement {
  const s = ev();
  return h("section", { className: "g-page" },
    h("h1", {}, "The night"),
    h("p", { className: "lead" }, "Night mode is one screen for the event: it checks the room, checks people in, runs the rounds on a clock, and tells you who to move when something changes. It works on a phone."),
    h("div", { className: "g-choices" },
      h("button", { className: "g-choice primary", onclick: () => ctx.openNight() }, h("strong", {}, "Open night mode"), h("span", {}, "Use this on the night.")),
      ctx.inPractice() ? null : h("button", { className: "g-choice", onclick: () => { practiceReturn = 5; ctx.practice(); } }, h("strong", {}, "Practice first"), h("span", {}, "Try a no-show and a late alum on a copy. Nothing is kept."))),
    s.printed ? null : h("div", { className: "msg warn" }, "You haven't printed yet. Print first, so changes on the night can say exactly what to reprint."),
    nav(4, "Next: next year", () => go(6)));
}

function nextYearPage(): HTMLElement {
  const s = ev();
  const notes = h("textarea", { rows: 5, "aria-label": "Notes for next year", placeholder: "What worked, what didn't, which table is loud…" }) as HTMLTextAreaElement;
  notes.value = s.notes;
  notes.addEventListener("input", () => { s.notes = notes.value; ctx.persist(); });
  return h("section", { className: "g-page" },
    h("h1", {}, "Next year"),
    h("p", { className: "lead" }, "Pass the event on, so next year's coordinator starts from your alumni, fams, and notes instead of a blank page."),
    field("Notes for next year", notes, "No student names here, please."),
    h("div", { className: "row" },
      h("button", { className: "button primary", onclick: () => ctx.handOff() }, "Download the hand-off folder"),
      h("button", { className: "button", onclick: () => {
        if (!sure) { sure = true; render(); return; }
        sure = false; ctx.removeStudentNames(); say("ok", "Student names removed."); render();
      } }, sure ? "Yes, delete student names from this event" : "Delete student names from this event")),
    h("p", { className: "help" }, "The hand-off folder's event file leaves out student names, this year's arrival times, cancellations, and schedules, and puts moved tables back where they were planned. It keeps alumni, fams, interests, lasting settings, and your notes; its README also lists what happened on the night, for context. Deleting names here is for after the event, if your office asks you not to keep them."),
    nav(5, null, () => undefined));
}

/** For tests and the app shell: go straight to a step. */
export function guidedStep(n: number): void { go(n); }
export const guidedFieldsCount = () => FIELDS.length;
