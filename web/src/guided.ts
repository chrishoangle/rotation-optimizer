// The planner a coordinator sees: four steps, in event words, for someone who
// runs one dinner a year.
//
//   Your lists  ->  Schedule  ->  Print  ->  Run the event
//
// Everything else (per-alum settings, extra printouts, the night's
// checklists, next year's hand-off) waits until it is asked for. The full
// planner, with every option, stays reachable at the address #full.

import { h, openPage, readFile, replace } from "./dom";
import {
  EventState, FAM_COLUMNS, HOST_COLUMNS, applySpelling, checkInputs, famLocations, hasStarted, isCurrent, loadEvent,
  maxRounds, nearMisses, newEvent, normalizeState, normalizeTable, stepFreeFams,
} from "./event";
import { explainPairing } from "./explain";
import { hostCardsHtml, runSheetHtml, seatingChartHtml, tableNumbers, tableTentsHtml } from "./export";
import { FIELDS } from "./forms";
import { changeSlipsHtml, movesBetween } from "./moves";
import { addLateHost, cancelFam, cancelHost, currentRound, finishRound, joinLate, logChange, moveFamTable, roomTables, toggleTold } from "./night";
import { looksLikeHeader, parsePasted } from "./paste";
import { HostSettings, clearGrid, gridChanges, hostSettings, placeInGrid, renameInRules, setHostSettings, settingsWords } from "./people";
import type { EventPlan } from "./planning";
import { hostLabel, provenOptimal } from "./planning";
import {
  backupPacketHtml, coordinatorGuideHtml, hostBadgesHtml, planSummaryHtml, printEverythingHtml, privacyNoteHtml, roleCardsHtml, runnerSheetsHtml,
} from "./printables";
import { csvRecords } from "./py";
import { CleanRow, dropExampleRows, groupStudentRows, matchColumns, renameColumns } from "./sheets";
import { endRound, leftText, nowMinutes, shown, startRound, status, toMinutes } from "./timing";

/** What the guided pages need from the app around them. */
export interface GuidedCtx {
  get(): EventState;
  set(s: EventState): void;
  persist(): void;
  now(): string;
  /** Plan or update the schedule; returns a problem in plain words, or "" when it worked. */
  solve(keepPrinted: boolean): Promise<string>;
  /** Every night-of tool: check-in, room setup, QR code, where is. */
  openNight(): void;
  openFull(): void;
  /** A copy of this event to practice on; nothing done to it is kept. */
  practice(): void;
  endPractice(): void;
  inPractice(): boolean;
  saveFile(): void;
  handOff(): void;
  markPrinted(): void;
  fileName(what: string, ext: string): string;
  tryExample(): void;
  removeStudentNames(): void;
  offlineCopy(): void;
}

const STEPS = ["Your lists", "Schedule", "Print", "Run the event"] as const;
const NEXT_YEAR = 4; // after the event, reached from Run the event or More
const STEP_KEY = "rotation-optimizer:step";

let ctx: GuidedCtx;
let step = -1; // -1 is the start screen
let message: [string, string] | null = null; // [kind, text], shown once
let problems: string[] = [];
let picked: { round: number; famId: string } | null = null; // the alum tapped first in the schedule
let why = false; // show why the picked alum is where they are
let editing: "hosts" | "fams" | null = null; // which list shows its editing grid
let adding: "hosts" | "fams" | null = null; // which list shows its paste box although it has rows
let noteFor: string | null = null; // the alum whose note (late, stairs, ...) is open
let more = false;
let details = false;
let changed: string[] = []; // what the last update moved, in sentences
let busy = false;
let sure = false; // the second tap of a remove
let practiceReturn: number | null = null; // the step to come back to when practice ends
let showMoreColumns = false;
// Run the event
let change: "left" | "arrived" | "table" | "famLeft" | null = null; // the open "Someone changed" form
let runProblem = "";
let beforeChange: EventPlan | null = null; // the plan before the last change, when nothing was printed
let showNext = false;
let justFinished: number | null = null;

const ev = () => ctx.get();

function remember(): void {
  try { localStorage.setItem(STEP_KEY, String(step)); } catch { /* the step is only a convenience */ }
}

function go(n: number): void {
  step = n;
  changed = [];
  problems = [];
  picked = null;
  why = false;
  editing = null;
  adding = null;
  noteFor = null;
  more = false;
  change = null;
  runProblem = "";
  remember();
  render();
  window.scrollTo(0, 0);
}

function say(kind: "ok" | "info" | "warn" | "error", text: string): void {
  message = [kind, text];
}

const named = (r: CleanRow) => (r.table_label || r.host_name || "").trim();
const hasPeople = (s: EventState) => s.hosts.some(named) || s.fams.some((r) => (r.fam_label || "").trim());

// ----------------------------------------------------------------------
// The frame.
// ----------------------------------------------------------------------

const LOGO = `<svg viewBox="0 0 40 40" width="28" height="28" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="var(--brand-soft)"/><circle cx="11" cy="14" r="4.2" fill="var(--brand)"/><circle cx="29" cy="14" r="4.2" fill="var(--brand)"/><circle cx="20" cy="29" r="4.2" fill="var(--brand)"/><path d="M15.5 12.5 Q20 9 24.5 12.5 M28 19.5 Q26 24.5 23.5 27 M16.5 27 Q13 24 12 19" fill="none" stroke="var(--brand)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

function logo(): HTMLElement {
  const span = h("span", { className: "g-logo" });
  span.innerHTML = LOGO;
  return span;
}

function header(): HTMLElement {
  const s = ev();
  const reached = furthest();
  const practising = ctx.inPractice();
  return h("header", { className: "g-head" },
    h("div", { className: "g-top" },
      logo(),
      h("strong", { className: "g-title" }, step >= 0 ? s.title || "Your dinner" : "Rotation Dinner"),
      practising
        ? h("span", { className: "g-pill practice" }, h("span", { className: "long" }, "Practice, nothing is kept "), h("span", { className: "short" }, "Practice "), h("button", { className: "button link", onclick: () => ctx.endPractice() }, "End"))
        : step >= 0 ? h("button", { className: "g-pill saved", title: "Saved in this browser as you work. Tap to download a copy you can keep or open on another computer.",
          onclick: () => { ctx.saveFile(); say("ok", "A copy of your event was downloaded. Keep it with your event files, or open it on another computer."); render(); } }, "Saved ✓ Download a copy") : null,
      h("div", { className: "g-more" },
        h("button", { className: "button small", "aria-expanded": more ? "true" : "false", onclick: () => { more = !more; render(); } }, "More"),
        more ? h("div", { className: "g-menu", role: "menu" },
          openFileItem(),
          h("button", { role: "menuitem", onclick: () => { more = false; go(-1); } }, "New event or example"),
          s.plan ? h("button", { role: "menuitem", onclick: () => go(NEXT_YEAR) }, "Save for next year") : null,
          s.plan ? h("button", { role: "menuitem", onclick: () => { more = false; ctx.openNight(); } }, "All night tools (check-in, room setup, QR code)") : null,
          h("button", { role: "menuitem", onclick: () => openPage(coordinatorGuideHtml(s.title)) }, "Print a one-page guide"),
          h("button", { role: "menuitem", onclick: () => { more = false; ctx.offlineCopy(); } }, "Download the app to use offline")) : null)),
    step >= 0 ? h("nav", { className: "g-steps", "aria-label": "Steps" }, STEPS.map((label, i) =>
      h("button", {
        className: `g-step ${i === step ? "now" : ""} ${i < step ? "done" : ""}`, disabled: i > reached,
        "aria-current": i === step ? "step" : null, onclick: () => go(i),
      }, h("span", { className: "n" }, String(i + 1)), h("span", { className: "l" }, label)))) : null);
}

function openFileItem(): HTMLElement {
  return h("label", { role: "menuitem", htmlFor: "g-open", for: "g-open", className: "g-menu-label" }, openInput("g-open"), "Open a saved event");
}

function openInput(id: string): HTMLElement {
  const input = h("input", { type: "file", accept: ".json,application/json", className: "visually-hidden", id }) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
      ctx.set(loadEvent(await readFile(f)));
      say("ok", `Opened ${f.name}.`);
      more = false;
      go(ev().plan ? 1 : 0);
    } catch {
      say("error", "That file is not a saved event. Choose a file you downloaded from this app.");
      render();
    }
  });
  return input;
}

/** The furthest step the coordinator can go to now. */
function furthest(): number {
  return ev().plan ? STEPS.length - 1 : 0;
}

function msg(): HTMLElement | null {
  if (!message) return null;
  const [kind, text] = message;
  message = null;
  return h("div", { className: `msg ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}

function nav(back: number | null, nextLabel: string | null, next: () => void): HTMLElement {
  return h("div", { className: "g-nav" },
    back !== null ? h("button", { className: "button", onclick: () => go(back) }, "Back") : h("span"),
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
    try {
      const raw = localStorage.getItem(STEP_KEY);
      const saved = raw === null ? -1 : Number(raw);
      if (saved >= 0) step = saved === NEXT_YEAR && ev().plan ? NEXT_YEAR : Math.min(saved, furthest());
    } catch { /* start screen */ }
  }
  render();
}

function render(): void {
  const app = document.getElementById("app")!;
  const pages = [listsPage, schedulePage, printPage, runPage, nextYearPage];
  const body = step === -1 ? startPage() : pages[Math.min(step, pages.length - 1)]();
  replace(app, h("main", { className: `guided ${step === 3 ? "running" : ""}`, id: "main" }, header(), msg(), body,
    h("footer", { className: "g-foot" }, ctx.inPractice() ? "Practice: nothing here is kept." : "Saved in this browser as you work. Nothing is sent anywhere.")));
}

// ----------------------------------------------------------------------
// Start.
// ----------------------------------------------------------------------

const PICTURE = `<svg viewBox="0 0 520 150" role="img" aria-label="Students stay at their tables while alumni move to the next table each round">
<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--brand)"/></marker></defs>
<g fill="var(--panel)" stroke="var(--line)" stroke-width="2">
<circle cx="90" cy="80" r="40"/><circle cx="260" cy="80" r="40"/><circle cx="430" cy="80" r="40"/></g>
<g fill="var(--muted)" font-size="15" font-weight="700" text-anchor="middle" font-family="inherit"><text x="90" y="86">1</text><text x="260" y="86">2</text><text x="430" y="86">3</text></g>
<g fill="var(--brand-soft)" stroke="var(--brand)" stroke-width="1.5">
<circle cx="62" cy="50" r="7"/><circle cx="118" cy="50" r="7"/><circle cx="62" cy="110" r="7"/>
<circle cx="232" cy="50" r="7"/><circle cx="288" cy="50" r="7"/><circle cx="288" cy="110" r="7"/>
<circle cx="402" cy="50" r="7"/><circle cx="458" cy="110" r="7"/><circle cx="402" cy="110" r="7"/></g>
<g fill="var(--brand)"><circle cx="118" cy="110" r="10"/><circle cx="232" cy="110" r="10"/><circle cx="458" cy="50" r="10"/></g>
<g fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-dasharray="6 5" marker-end="url(#ah)">
<path d="M132 118 Q175 140 216 120"/><path d="M246 122 Q360 150 448 68"/></g>
</svg>`;

function startPage(): HTMLElement {
  const s = ev();
  const going = hasPeople(s) && !ctx.inPractice();
  const picture = h("div", { className: "g-picture" });
  picture.innerHTML = PICTURE;
  return h("section", { className: "g-page g-start" },
    h("h1", {}, "Plan your rotation dinner in minutes"),
    h("p", { className: "lead" }, "Students stay at their table all night. Alumni move to a new table each round. Paste your two lists, print the cards, and run the night from your phone."),
    picture,
    h("p", { className: "g-promise" }, h("strong", {}, "When someone cancels on the night, "), "tap Someone changed? and pick who. The app re-plans in seconds and tells you exactly who walks where."),
    h("div", { className: "g-choices" },
      going ? h("button", { className: "g-choice primary", onclick: () => go(Math.min(furthest(), 1)) },
        h("strong", {}, `Continue ${s.title || "your dinner"}`), h("span", {}, `${s.hosts.length} alumni, ${s.fams.length} fams`)) : null,
      h("button", { className: `g-choice ${going ? "" : "primary"}`, onclick: () => {
        ctx.set(newEvent({ title: "", rounds: 3 }));
        go(0);
      } }, h("strong", {}, "Start a new dinner"), h("span", {}, "Paste your alumni and fams from a spreadsheet.")),
      h("label", { className: "g-choice", htmlFor: "g-open-start", for: "g-open-start" }, openInput("g-open-start"),
        h("strong", {}, "Open a saved event"), h("span", {}, "A file you downloaded, or last year's.")),
      h("button", { className: "g-choice", onclick: async () => { practiceReturn = -1; ctx.tryExample(); go(1); await update(); } },
        h("strong", {}, "See an example"), h("span", {}, "A practice dinner. Nothing you do is kept."))));
}

// ----------------------------------------------------------------------
// Your lists: alumni and fams, pasted from a spreadsheet.
// ----------------------------------------------------------------------

interface Col { key: string; label: string; placeholder: string; wide?: boolean }

const ALUMNI: Col[] = [
  { key: "host_name", label: "Name", placeholder: "e.g. Sam Rivera" },
  { key: "tags", label: "Can talk about", placeholder: "law; policy; startups", wide: true },
];
const ALUMNI_EXTRA: Col[] = [{ key: "table_label", label: "Topic for the signs", placeholder: "e.g. Law" }];
const FAMS: Col[] = [
  { key: "table_number", label: "Table", placeholder: "1" },
  { key: "fam_label", label: "Fam name", placeholder: "Fam Red" },
  { key: "interests", label: "Interested in", placeholder: "biology; pre-med", wide: true },
];
const FAM_EXTRA: Col[] = [
  { key: "students", label: "Students", placeholder: "Student 01; Student 02", wide: true },
  { key: "size", label: "How many", placeholder: "6" },
  { key: "location", label: "Where in the room", placeholder: "by the stage" },
  { key: "step_free", label: "Step-free?", placeholder: "yes" },
];

const blankRow = (kind: "hosts" | "fams"): CleanRow => Object.fromEntries((kind === "hosts" ? HOST_COLUMNS : FAM_COLUMNS).map((k) => [k, ""]));

/** Fill in what the planner needs: a topic is the alum's name when left blank. */
function tidy(s: EventState): void {
  for (const r of s.hosts) if (!(r.table_label ?? "").trim() && (r.host_name ?? "").trim()) r.table_label = r.host_name.trim();
  normalizeState(s);
}

/**
 * Rows pasted or typed into a list. With a header row the columns are matched
 * by name; without one, by position: alumni are name then interests (or name,
 * topic, interests), fams are name then interests, with a table number first
 * when the first column is all numbers.
 */
function addRows(kind: "hosts" | "fams", grid: string[][]): string {
  const s = ev();
  const list = kind === "hosts" ? s.hosts : s.fams;
  const mapping = matchColumns(grid[0], kind);
  const byHeader = looksLikeHeader(grid[0]) && ((kind === "hosts" ? "table_label" : "fam_label") in mapping || "host_name" in mapping);
  const body = (byHeader ? grid.slice(1) : grid).filter((r) => r.some((c) => c.trim()));
  const width = Math.max(...body.map((r) => r.length));
  const numbered = kind === "fams" && body.every((r) => /^\d+$/.test((r[0] ?? "").trim()));
  const order = kind === "hosts"
    ? (width >= 3 ? ["host_name", "table_label", "tags"] : ["host_name", "tags"])
    : numbered ? ["table_number", "fam_label", "interests", "students"] : ["fam_label", "interests", "students"];
  for (const cells of body) {
    const row = blankRow(kind);
    if (byHeader) for (const [ours, theirs] of Object.entries(mapping)) row[ours] = cells[grid[0].indexOf(theirs)] ?? "";
    else order.forEach((k, j) => { row[k] = (cells[j] ?? "").trim(); });
    list.push(row);
  }
  tidy(s);
  ctx.persist();
  const n = body.length;
  return kind === "hosts" ? `Added ${n} alum${n !== 1 ? "ni" : ""}.` : `Added ${n} fam${n !== 1 ? "s" : ""}.`;
}

/** Typed lines: tabs if there are any, otherwise the name is before the first comma or colon. */
function typedGrid(text: string): string[][] {
  const pasted = parsePasted(text);
  if (pasted && pasted.some((r) => r.length > 1)) return pasted;
  return text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^([^,:]+)[,:](.*)$/);
    return m ? [m[1].trim(), m[2].trim()] : [l];
  });
}

function pasteBox(kind: "hosts" | "fams"): HTMLElement {
  const example = kind === "hosts"
    ? "Paste from your spreadsheet, or type one alum per line:\nSam Rivera, law; policy\nPriya Shah, medicine; biology"
    : "Paste from your spreadsheet, or type one fam per line:\nFam Red, biology; pre-med\nFam Blue, law; history";
  const box = h("textarea", { rows: 5, className: "g-paste", placeholder: example, "aria-label": kind === "hosts" ? "Paste alumni" : "Paste fams" }) as HTMLTextAreaElement;
  const add = () => {
    const grid = typedGrid(box.value);
    if (!grid.length) return;
    say("ok", addRows(kind, grid));
    adding = null;
    render();
  };
  box.addEventListener("paste", (e) => {
    const grid = parsePasted((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
    if (!grid) return;
    e.preventDefault();
    say("ok", addRows(kind, grid));
    adding = null;
    render();
  });
  return h("div", { className: "g-paste-zone" },
    box,
    h("div", { className: "row" },
      h("button", { className: "button primary", onclick: add }, "Add these"),
      uploadButton(kind),
      h("button", { className: "button link", onclick: () => { editing = kind; adding = null; render(); } }, "Type them into a table instead"),
      ev()[kind].length ? h("button", { className: "button link", onclick: () => { adding = null; render(); } }, "Cancel") : null),
    kind === "hosts" ? h("p", { className: "help" }, "Interests are separated by semicolons. Use the same words for alumni and fams, because matches count shared words.") : null);
}

function readList(kind: "hosts" | "fams"): HTMLElement {
  const s = ev();
  if (kind === "hosts") {
    return h("ul", { className: "g-read", "data-kind": "hosts" }, s.hosts.filter(named).map((r) => h("li", {},
      h("strong", {}, r.host_name || r.table_label),
      r.host_name && r.table_label && r.table_label !== r.host_name ? h("span", { className: "g-topic" }, r.table_label) : null,
      h("span", { className: "g-int" }, (r.tags ?? "").split(/;/).map((t) => t.trim()).filter(Boolean).join(", ") || "no interests yet"),
      settingsWords(s, r.host_id).map((w) => h("span", { className: "g-tag" }, w)))));
  }
  const tables = roomTables(s);
  return h("ul", { className: "g-read", "data-kind": "fams" }, s.fams.filter((r) => (r.fam_label ?? "").trim()).map((r) => h("li", {},
    h("span", { className: "tn" }, String(tables[r.fam_id] ?? "")),
    h("strong", {}, r.fam_label),
    h("span", { className: "g-int" }, (r.interests ?? "").split(/;/).map((t) => t.trim()).filter(Boolean).join(", ") || "no interests yet"),
    /^(y|yes|true|1)$/i.test((r.step_free ?? "").trim()) ? h("span", { className: "g-tag" }, "step-free") : null)));
}

function listSection(kind: "hosts" | "fams"): HTMLElement {
  const s = ev();
  const rows = kind === "hosts" ? s.hosts.filter(named) : s.fams.filter((r) => (r.fam_label ?? "").trim());
  const title = kind === "hosts" ? "Alumni" : "Fams";
  const count = rows.length ? h("span", { className: "g-count" }, String(rows.length)) : null;
  let body: (HTMLElement | null)[];
  if (editing === kind) {
    const cols = kind === "hosts" ? (showMoreColumns ? [...ALUMNI_EXTRA, ...ALUMNI] : ALUMNI) : (showMoreColumns ? [...FAMS, ...FAM_EXTRA] : FAMS);
    body = [
      peopleList(kind, cols),
      h("div", { className: "row" },
        h("button", { className: "button primary", onclick: () => { tidy(s); ctx.persist(); editing = null; render(); } }, "Done"),
        h("button", { className: "button link", onclick: () => { showMoreColumns = !showMoreColumns; render(); } },
          showMoreColumns ? "Fewer columns" : kind === "hosts" ? "More columns: topic for the signs" : "More columns: students, size, where, step-free")),
    ];
  } else if (!rows.length || adding === kind) {
    body = [pasteBox(kind), rows.length ? readList(kind) : null];
  } else {
    body = [
      readList(kind),
      h("div", { className: "row" },
        h("button", { className: "button small", onclick: () => { editing = kind; render(); } }, "Edit"),
        h("button", { className: "button small", onclick: () => { adding = kind; render(); } }, kind === "hosts" ? "Add more alumni" : "Add more fams")),
      kind === "hosts" ? notesLine() : null,
    ];
  }
  return h("section", { className: "g-card", "data-list": kind }, h("h2", {}, title, " ", count), ...body);
}

/** One line for the few alumni who need something special, instead of a link on every row. */
function notesLine(): HTMLElement {
  const s = ev();
  const pick = h("select", { "aria-label": "Alum who needs something" },
    h("option", { value: "" }, "Choose an alum…"),
    s.hosts.filter(named).map((r) => h("option", { value: r.host_id, selected: r.host_id === noteFor }, r.host_name || r.table_label))) as HTMLSelectElement;
  pick.addEventListener("change", () => { noteFor = pick.value || null; render(); });
  const row = noteFor ? s.hosts.find((r) => r.host_id === noteFor) : null;
  return h("div", { className: "g-notes" },
    h("p", {}, "Anyone arriving late, leaving early, or who can't use stairs? ", pick),
    row ? settingsPanel(row) : null);
}

function peopleList(kind: "hosts" | "fams", cols: Col[]): HTMLElement {
  const s = ev();
  const rows = () => (kind === "hosts" ? s.hosts : s.fams);
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
              const blank = blankRow(kind);
              blank[c.key] = input.value;
              rows().push(blank);
              normalizeState(s);
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
            say("ok", addRows(kind, grid));
            render();
          });
          input.addEventListener("keydown", (e) => {
            if ((e as KeyboardEvent).key !== "Enter") return;
            e.preventDefault();
            list.querySelectorAll<HTMLElement>(`.g-row:not(.g-row-head)`)[i + 1]?.querySelector<HTMLInputElement>(`[data-col="${c.key}"]`)?.focus();
          });
          return input;
        });
        return h("div", { className: `g-row ${row ? "" : "new"}` }, cells,
          row ? h("button", { className: "button icon g-x", title: "Remove", tabindex: -1, "aria-label": `Remove row ${i + 1}`, onclick: () => {
            rows().splice(i, 1);
            ctx.persist();
            draw();
          } }, "×") : h("span", { className: "g-x" }));
      }));
  };
  draw();
  return list;
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
      say("error", `Could not tell which column holds the ${kind === "hosts" ? "alumni" : "fam names"}. Columns found: ${columns.join(", ")}. Rename that column to ${kind === "hosts" ? "Name" : "Fam name"} and upload again, or paste the rows instead.`);
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
    tidy(s);
    ctx.persist();
    adding = null;
    say("ok", `Read ${clean.length} ${kind === "hosts" ? "alumni" : "fams"} from ${f.name}` + (grouped ? `, grouping ${grouped} student answers by fam.` : ".") + " Email and phone columns are never kept.");
    render();
  });
  return h("label", { className: "button", htmlFor: id, for: id }, input, "Upload a file");
}

function settingsPanel(row: CleanRow): HTMLElement {
  const s = ev();
  const n = s.rounds;
  const x = hostSettings(s, row.host_id);
  const save = (next: Partial<HostSettings>) => { tidy(s); setHostSettings(s, row.host_id, { ...hostSettings(s, row.host_id), ...next }); ctx.persist(); render(); };
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
  // A stairs setting needs step-free tables: mark them right here.
  const stepFree = x.stepFree ? h("div", { className: "g-stepfree" },
    h("span", { className: "help" }, "Which fam tables can be reached without stairs?"),
    s.fams.filter((r) => (r.fam_label ?? "").trim()).map((r) => {
      const box = h("input", { type: "checkbox", checked: /^(y|yes|true|1)$/i.test((r.step_free ?? "").trim()) }) as HTMLInputElement;
      box.addEventListener("change", () => { r.step_free = box.checked ? "yes" : ""; ctx.persist(); render(); });
      return h("label", { className: "check light" }, box, ` ${r.fam_label}`);
    })) : null;
  return h("div", { className: "g-settings panel" },
    h("strong", {}, row.host_name || row.table_label),
    h("div", { className: "row" }, h("span", {}, "Hosts from"), roundSel("Hosts from round", x.from, (v) => save({ from: v, until: Math.max(v, x.until) })),
      h("span", {}, "to"), roundSel("Hosts until round", x.until, (v) => save({ until: v, from: Math.min(v, x.from) }))),
    check("Can't use stairs", x.stepFree, (v) => save({ stepFree: v }), "Only visits step-free tables."),
    stepFree,
    h("details", { className: "g-rare" }, h("summary", {}, "Rarely needed"),
      check("Stays at one table all night", x.stays, (v) => save({ stays: v }), "For someone who can't move between tables."),
      famPick("Must meet", x.must, (v) => save({ must: v })),
      famPick("Never meets", x.never, (v) => save({ never: v }))),
    h("button", { className: "button small", onclick: () => { noteFor = null; render(); } }, "Done"));
}

function listsPage(): HTMLElement {
  const s = ev();
  const rounds = h("select", { "aria-label": "Rounds" }, [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: n, selected: n === s.rounds }, `${n} round${n !== 1 ? "s" : ""}`))) as HTMLSelectElement;
  rounds.addEventListener("change", () => { s.rounds = Number(rounds.value); s.finished = Math.min(s.finished, s.rounds - 1); ctx.persist(); });
  return h("section", { className: "g-page" },
    h("h1", {}, "Your lists"),
    h("p", { className: "lead" }, "Paste your alumni and your fams straight from your spreadsheet. That's all the app needs."),
    problemsBox(),
    h("section", { className: "g-card g-name" }, field("Name of your dinner", titleInput(), "Printed at the top of every page. You can change it later.")),
    listSection("hosts"),
    listSection("fams"),
    h("section", { className: "g-card g-rounds" },
      h("label", { className: "field" }, h("span", { className: "label" }, "How many rounds?"), rounds,
        h("span", { className: "help" }, "Each round, every alum moves to a new fam."))),
    nav(null, "Make the schedule", async () => {
      tidy(s);
      problems = checkInputs({ ...s, rules: [] }).problems;
      if (!s.hosts.length) problems.unshift("Add your alumni.");
      if (!s.fams.length) problems.push("Add your fams.");
      const free = stepFreeFams(s);
      const stairs = s.hosts.find((r) => hostSettings(s, r.host_id).stepFree);
      if (stairs && !free.length) { problems.push(`${stairs.host_name || stairs.table_label} can't use stairs: tick at least one step-free fam table in their note below.`); noteFor = stairs.host_id; }
      if (s.hosts.length && s.fams.length && s.rounds > maxRounds(s)) problems.push(`With ${s.hosts.length} alumni and ${s.fams.length} fams, the most rounds without a repeat is ${maxRounds(s)}. Choose fewer rounds.`);
      if (problems.length) { render(); window.scrollTo(0, 0); return; }
      if (!s.title.trim()) s.title = "Alumni dinner";
      ctx.persist();
      go(1);
      await update();
    }));
}

function problemsBox(): HTMLElement | null {
  if (!problems.length) return null;
  return h("div", { className: "msg error", role: "alert" }, h("strong", {}, "Before making the schedule:"), h("ul", {}, problems.map((p) => h("li", {}, plain(p)))));
}

/** The planner's words, in a coordinator's. */
function plain(text: string): string {
  return text.replace(/host tables?/g, (m) => (m.endsWith("s") ? "alumni" : "alum")).replace(/\bHost tables?\b/g, (m) => (m.endsWith("s") ? "Alumni" : "Alum"))
    .replace(/\btags?\b/g, "interests").replace(/\bhosts\b/g, "alumni").replace(/\bhost\b/g, "alum")
    .replace(/Pairing rule \d+: /, "").replace(/pairing rule/g, "setting").replace(/\b([Aa]) alum/g, "$1n alum");
}

/** A planner warning in a coordinator's words. */
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
// Schedule: a list per table; tap two alumni in a round to swap them.
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
    changed = movesBetween(before, s.plan, s.finished + 1).hosts.map((x) => x.text);
  } else changed = [];
  render();
}

/** "Every fam meets 3 alumni", the one number a coordinator checks. */
function headline(p: EventPlan): string {
  const met = p.fams.map((f) => new Set(p.assignments.filter((a) => a.groupId === f.groupId).map((a) => a.hostId)).size);
  const lo = Math.min(...met), hi = Math.max(...met);
  const alumni = (n: number) => `${n} alum${n !== 1 ? "ni" : ""}`;
  return lo === hi ? `Every fam meets ${alumni(lo)}, and never the same one twice.` : `Each fam meets ${lo} to ${alumni(hi)}, and never the same one twice.`;
}

function schedulePage(): HTMLElement {
  const s = ev();
  const p = s.plan;
  if (busy) return h("section", { className: "g-page" }, h("h1", {}, "Your schedule"), h("p", { className: "lead" }, h("span", { className: "spinner" }), " Working out who sits where…"));
  if (!p) return h("section", { className: "g-page" }, h("h1", {}, "Your schedule"), h("button", { className: "button primary big", onclick: () => update() }, "Make the schedule"));
  const current = isCurrent(s);
  const stretch = p.assignments.filter((a) => a.score === 0).length;
  const look = worthALook(p);
  const mine = gridChanges(s);
  return h("section", { className: "g-page" },
    h("h1", {}, "Your schedule"),
    current ? null : h("div", { className: "msg warn row spread" }, "You changed your lists since this schedule was made.",
      h("button", { className: "button primary", disabled: busy, onclick: () => update() }, "Update the schedule")),
    h("p", { className: "g-headline" }, headline(p),
      stretch ? h("span", { className: "help" }, ` ${stretch} visit${stretch !== 1 ? "s have" : " has"} nothing in common; ${stretch !== 1 ? "they are" : "it is"} marked.`) : null),
    changed.length ? h("div", { className: "msg info" }, h("strong", {}, "Updated. What moved:"),
      h("ul", {}, changed.slice(0, 6).map((c) => h("li", {}, c))),
      changed.length > 6 ? h("details", {}, h("summary", {}, `${changed.length - 6} more`), h("ul", {}, changed.slice(6).map((c) => h("li", {}, c)))) : null) : null,
    look.length ? h("div", { className: "g-look" }, h("h2", {}, "Worth a look"), look) : null,
    pickBar(p, current),
    tableList(p, current),
    whoSitsOut(p),
    mine.length ? h("div", { className: "g-mine" }, `${mine.length} alum${mine.length !== 1 ? "ni" : ""} placed by hand. `,
      h("button", { className: "button link", onclick: async () => { clearGrid(s); ctx.persist(); await update(); } }, "Undo my moves")) : null,
    h("details", { className: "g-details", open: details, ontoggle: (e: Event) => { details = (e.target as HTMLDetailsElement).open; } },
      h("summary", {}, "Details"),
      h("p", {}, provenOptimal(p) ? (p.keptSlots !== null
        ? "This is the best update: every fam's night stays as fair as it can be, and as little as possible of what you printed changes."
        : "This is the best possible schedule for these people: no other one gives more shared interests.") : "The app stopped before checking every possible schedule."),
      p.warnings.length ? h("ul", {}, p.warnings.map((w) => h("li", {}, warningWords(w)))) : null),
    nav(0, current ? "Next: print" : null, () => go(2)));
}

function pickBar(p: EventPlan, current: boolean): HTMLElement {
  if (!current) return h("p", { className: "help" }, "Update the schedule first, then you can move people.");
  if (!picked) return h("p", { className: "help" }, "To swap two alumni, tap one, then tap another in the same round.");
  const a = p.assignments.find((x) => x.round === picked!.round && x.groupId === picked!.famId);
  const host = a ? p.hosts.find((x) => x.hostId === a.hostId) : null;
  const who = host ? host.person || host.name : "This empty seat";
  return h("div", { className: "g-pick" },
    h("p", {}, h("strong", {}, `${who} picked for round ${picked.round}. `), `Tap another alum in round ${picked.round} to swap.`),
    h("div", { className: "row" },
      host ? h("button", { className: "button small", "aria-expanded": why ? "true" : "false", onclick: () => { why = !why; render(); } }, why ? "Hide why" : `Why is ${who} here?`) : null,
      h("button", { className: "button small", onclick: () => { picked = null; why = false; render(); } }, "Cancel")),
    why && host ? whyBox(p) : null);
}

function tableList(p: EventPlan, current: boolean): HTMLElement {
  const s = ev();
  const tables = tableNumbers(p);
  const fams = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const rounds = Array.from({ length: p.rounds }, (_, k) => k + 1);
  const locked = new Set(p.lockedRounds);
  return h("ol", { className: "g-tables" }, fams.map((f) => h("li", { className: "g-table" },
    h("div", { className: "g-table-head" }, h("span", { className: "tn" }, String(tables[f.groupId])), h("strong", {}, f.name)),
    h("div", { className: "g-visits" }, rounds.map((r) => {
      const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
      const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
      const gone = (p.famAway[f.groupId] ?? []).includes(r);
      const isPicked = picked?.round === r && picked.famId === f.groupId;
      const can = current && !locked.has(r) && r > s.finished && !gone && !busy;
      const weak = !!a && a.score === 0;
      const blocked = !!picked && picked.round === r && !isPicked && can ? swapBlock(p, r, picked.famId, f.groupId) : "";
      return h("button", {
        className: `g-visit ${weak ? "weak" : ""} ${!host ? "empty" : ""} ${isPicked ? "picked" : ""} ${picked && picked.round === r && !isPicked ? "target" : ""}`,
        disabled: !can || !!blocked, title: blocked || null, "aria-pressed": isPicked ? "true" : "false", "data-round": r,
        onclick: () => tapVisit(p, r, f.groupId),
      },
      h("span", { className: "r" }, `Round ${r}${r <= s.finished ? " (done)" : ""}`),
      h("span", { className: "g-name" }, gone ? "Fam not here" : host ? (host.person || host.name) : "No alum this round"),
      weak ? h("span", { className: "g-sub" }, "nothing in common") : null);
    })))));
}

function whoSitsOut(p: EventPlan): HTMLElement | null {
  const lines = Array.from({ length: p.rounds }, (_, k) => k + 1).map((r) => {
    const out = p.hosts.filter((x) => !p.assignments.some((a) => a.round === r && a.hostId === x.hostId)).map((x) => {
      const who = x.person || x.name;
      if ((p.hostAway[x.hostId] ?? []).includes(r)) return `${who} (cancelled)`;
      if ((p.hostLimits[x.hostId] ?? []).includes(r)) return `${who} (not here yet)`;
      return `${who} (break)`;
    });
    return out.length ? `Round ${r}: ${out.join(", ")}` : "";
  }).filter(Boolean);
  return lines.length ? h("p", { className: "help g-out" }, h("strong", {}, "Not at a table: "), lines.join(" · ")) : null;
}

async function tapVisit(p: EventPlan, r: number, famId: string): Promise<void> {
  if (!picked || picked.round !== r) { picked = { round: r, famId }; why = false; render(); return; }
  if (picked.famId === famId) { picked = null; why = false; render(); return; }
  const picked0 = picked.famId;
  const s = ev();
  const rulesBefore = structuredClone(s.rules);
  const a = p.assignments.find((x) => x.round === r && x.groupId === picked0);
  const b = p.assignments.find((x) => x.round === r && x.groupId === famId);
  const famA = p.fams.find((f) => f.groupId === picked0)!.name, famB = p.fams.find((f) => f.groupId === famId)!.name;
  const nameOf = (id: string) => p.hosts.find((x) => x.hostId === id)!.name;
  if (a) placeInGrid(s, nameOf(a.hostId), famB, r);
  if (b) placeInGrid(s, nameOf(b.hostId), famA, r);
  picked = null;
  why = false;
  ctx.persist();
  await update(true);
  if (isCurrent(s) && changed.length) {
    const here = changed.filter((c) => c.includes(`in round ${r},`));
    const elsewhere = changed.filter((c) => !c.includes(`in round ${r},`));
    if (elsewhere.length) changed = [...here, `To keep every fam from meeting the same alum twice, ${elsewhere.length} change${elsewhere.length !== 1 ? "s were" : " was"} also needed in other rounds:`, ...elsewhere];
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

/** A reason the swap of these two seats breaks an alum's setting, or "" when it may fit. */
function swapBlock(p: EventPlan, r: number, fromFam: string, toFam: string): string {
  const a = p.assignments.find((x) => x.round === r && x.groupId === fromFam);
  const b = p.assignments.find((x) => x.round === r && x.groupId === toFam);
  const moves: [string, string][] = [];
  if (a) moves.push([a.hostId, toFam]);
  if (b) moves.push([b.hostId, fromFam]);
  const why = refusal(p, r, moves);
  return why.startsWith("That move doesn't fit") ? "" : why;
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
  const round = picked!.round, famId = picked!.famId;
  const x = explainPairing(p, round, famId);
  const s = ev();
  const limited = (label: string) => s.rules.some((r) => (r.host_table ?? "").toLowerCase() === label.toLowerCase() && ["needs step-free", "stays with", "never meet"].includes(r.rule));
  const lines = x.lines.filter((l) => {
    if (l.startsWith("The schedule maximizes")) return false;
    const m = l.match(/^The best match for .+ is (.+?) \(score/);
    return !(m && limited(m[1]));
  });
  const fam = p.fams.find((f) => f.groupId === famId)!;
  const seated = p.assignments.find((a) => a.round === round && a.groupId === famId)?.hostId;
  const stepFree = stepFreeFams(s).includes(famId);
  const reasons: string[] = [];
  for (const r of s.rules) {
    const who = s.hosts.find((y) => (y.table_label ?? "").toLowerCase() === (r.host_table ?? "").toLowerCase());
    if (!who || who.host_id === seated) continue;
    if (r.rule === "needs step-free" && stepFree) continue;
    const name = who.host_name || who.table_label;
    const shares = (who.tags ?? "").toLowerCase().split(/[;,]/).map((t) => t.trim()).some((t) => t && fam.interests.includes(t));
    if (!shares) continue;
    if (r.rule === "needs step-free") reasons.push(`${name} would be a good match but can't use stairs, so only visits step-free tables.`);
    else if (r.rule === "stays with") reasons.push(`${name} would be a good match but stays at one table all night.`);
    else if (r.rule === "never meet" && (r.fam ?? "").toLowerCase() === fam.name.toLowerCase()) reasons.push(`${name} would be a good match but is set to never meet ${fam.name}.`);
  }
  return h("div", { className: "g-why-box" },
    lines.map((l) => h("p", {}, plain(l.replace(/ \(score \d+\)/, "").replace(/, so the pairing scores \d+\./, ".").replace(/ shares none of (.+)'s fields, so the pairing scores 0\./, " has nothing in common with $1.")
      .replace(/ shares none of (.+)'s interests, so the pairing scores 0\./, " has nothing in common with $1.")))),
    reasons.map((y) => h("p", {}, y)),
    lines.some((l) => l.startsWith("The best match")) ? h("p", { className: "help" }, "The schedule balances every fam at once, so a fam sometimes gets its second choice.") : null);
}

/** Only what may need the coordinator: spellings that look the same, and unfair nights. */
function worthALook(p: EventPlan): HTMLElement[] {
  const s = ev();
  const out: HTMLElement[] = [];
  for (const m of nearMisses(s.hosts, s.fams)) {
    out.push(h("div", { className: "g-item" }, `${m.spellings.join(" and ")} look like the same interest, but only exact words match.`,
      h("button", { className: "button small", onclick: async () => { applySpelling(s, m); ctx.persist(); await update(); } }, `Use "${m.suggestion}" for all`)));
  }
  const free = stepFreeFams(s);
  for (const [hostId, rs] of Object.entries(p.hostBreaks)) {
    const x = hostSettings(s, hostId);
    if (!x.stepFree) continue;
    const who = p.hosts.find((y) => y.hostId === hostId)!;
    const sitOut = rs.filter((r) => r >= x.from && r <= x.until && !(p.hostAway[hostId] ?? []).includes(r));
    if (!sitOut.length) continue;
    out.push(h("div", { className: "g-item" },
      `${who.person || who.name} sits out round${sitOut.length !== 1 ? "s" : ""} ${sitOut.join(" and ")}: they can't use stairs, and only ${free.length} table${free.length !== 1 ? "s are" : " is"} step-free, so they can visit ${free.length !== 1 ? "each" : "it"} once.`,
      h("button", { className: "button small", onclick: () => { go(0); noteFor = hostId; render(); } }, "Mark more tables step-free")));
  }
  const fair = p.warnings.filter((x) => x.startsWith("Fairness check"));
  const shared = (w: string) => warningWords(w).match(/ There are more fams than .+$/)?.[0] ?? "";
  const lines = fair.map((w) => warningWords(w).replace(shared(w), ""));
  const reason = fair.map(shared).find((x) => x);
  if (fair.length > 2) {
    // Many fams at once usually means few shared interests, not a bad schedule.
    const weak = p.assignments.filter((a) => a.score === 0).length;
    const empty = p.fams.reduce((n, f) => n + Array.from({ length: p.rounds }, (_, k) => k + 1)
      .filter((r) => !(p.famAway[f.groupId] ?? []).includes(r) && !p.assignments.some((a) => a.round === r && a.groupId === f.groupId)).length, 0);
    const bits = [weak ? `${weak} of ${p.assignments.length} visits share no interest` : "", empty ? `${empty} fam round${empty !== 1 ? "s have" : " has"} no alum` : ""].filter(Boolean);
    out.push(h("div", { className: "g-item" }, `${bits.join(", and ")}. That is normal when your two lists share few words.`,
      h("span", { className: "help" }, reason ? reason.trim() : "Adding more interests to both lists gives better matches.")));
    out.push(h("details", { className: "g-rare" }, h("summary", {}, "Which fams"), lines.map((l) => h("p", {}, l))));
  } else if (fair.length) {
    for (const l of lines) out.push(h("div", { className: "g-item" }, l));
    out.push(h("p", { className: "help" }, reason ? reason.trim() : "To fix it, tap an alum and swap in one who shares an interest."));
  }
  return out;
}

// ----------------------------------------------------------------------
// Print.
// ----------------------------------------------------------------------

function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  return h("label", { className: "field" }, h("span", { className: "label" }, label), input, help ? h("span", { className: "help" }, help) : null);
}

function titleInput(): HTMLInputElement {
  const s = ev();
  const name = h("input", { type: "text", value: s.title, placeholder: "Transfer Admit Dinner", "aria-label": "Event name" }) as HTMLInputElement;
  name.addEventListener("input", () => { s.title = name.value; ctx.persist(); const t = document.querySelector(".g-title"); if (t) t.textContent = s.title || "Your dinner"; });
  return name;
}

function printPage(): HTMLElement {
  const s = ev();
  const p = s.plan!;
  const loc = famLocations(s);
  const name = titleInput();
  const doors = h("input", { type: "text", value: s.startTime, placeholder: "6:30 PM", "aria-label": "Doors open at" }) as HTMLInputElement;
  doors.addEventListener("input", () => { s.startTime = doors.value; ctx.persist(); });
  const minutes = h("select", { "aria-label": "Minutes per round" }, [10, 15, 20, 25, 30, 40].map((n) => h("option", { value: n, selected: n === s.roundMinutes }, `${n} minutes`))) as HTMLSelectElement;
  minutes.addEventListener("change", () => { s.roundMinutes = Number(minutes.value); ctx.persist(); });
  const date = h("input", { type: "date", value: s.night.date ?? "", "aria-label": "Date of the event" }) as HTMLInputElement;
  date.addEventListener("change", () => { s.night = { ...s.night, date: date.value }; ctx.persist(); });
  const main: [string, string, () => string][] = [
    ["Seating chart", "who is at each table, each round", () => seatingChartHtml(p, s.title, null, true, "", loc)],
    ["Host cards", "half a page per alum: where to go each round", () => hostCardsHtml(p, null, s.title, "", loc)],
    ["Table tents", "a big number for each table", () => tableTentsHtml(p)],
    ["Run sheet", "timeline for you and the MC", () => runSheetHtml(p, s.title, s.startTime, s.roundMinutes)],
  ];
  const extra: [string, string, () => string][] = [
    ["Backup packet", "the whole night on paper", () => backupPacketHtml(p, s.title, s.printedAt)],
    ["Host badges", "each alum's tables, for a name badge", () => hostBadgesHtml(p, s.title, loc)],
    ["Runner sheets", "for two volunteers", () => runnerSheetsHtml(p, s.title, 2, loc)],
    ["Volunteer role cards", "door, runner, MC, floater", () => roleCardsHtml(s.title)],
    ["Plan summary", "for a director", () => planSummaryHtml(p, s.title, [], s.notes)],
    ["Privacy note", "for IT or a supervisor", () => privacyNoteHtml()],
  ];
  const recorded = () => { if (!s.printed) { ctx.markPrinted(); say("ok", "Printed. If anything changes later, the app tells you exactly what to reprint."); } };
  const one = ([label, help, make]: [string, string, () => string]) => h("li", {},
    h("button", { className: "button small", onclick: () => { openPage(make()); recorded(); render(); } }, "Open"),
    h("span", {}, h("strong", {}, label), h("span", { className: "help" }, `: ${help}`)));
  return h("section", { className: "g-page" },
    h("h1", {}, "Print"),
    h("div", { className: "g-card g-print-all" },
      h("p", { className: "lead" }, "One file with everything for the night: the seating chart, a card for each alum, table numbers, and a run sheet."),
      h("div", { className: "g-print-form" },
        field("Event name", name), field("Doors open", doors), field("Each round", minutes), field("Date (optional)", date)),
      h("button", { className: "button primary big", onclick: () => {
        if (!s.title.trim()) s.title = "Alumni dinner";
        openPage(printEverythingHtml(s.title, main.map(([label, , make]) => [label, make()])));
        recorded();
        render();
      } }, "Print everything"),
      s.printed ? h("p", { className: "help" }, `Printed${s.printedAt ? ` at ${s.printedAt}` : ""}. Changes later on list exactly what to reprint.`) : null),
    h("details", { className: "g-details" }, h("summary", {}, "Print one at a time, or more pages for your team"),
      h("ul", { className: "g-print" }, [...main, ...extra].map(one))),
    nav(1, "Next: run the event", () => go(3)));
}

// ----------------------------------------------------------------------
// Run the event: the round, who is where, and one button for changes.
// ----------------------------------------------------------------------

const alumLabel = (s: EventState, id: string) => {
  const r = s.hosts.find((x) => x.host_id === id);
  return r ? r.host_name || r.table_label : id;
};

async function applyChange(apply: () => string): Promise<void> {
  const s = ev();
  runProblem = apply();
  if (runProblem) { render(); return; }
  if (!s.printed) beforeChange = s.plan;
  change = null;
  busy = true;
  render();
  const err = await ctx.solve(true);
  busy = false;
  if (err) runProblem = plain(err);
  else {
    logChange(s, ctx.now(), "Re-planned.");
    const base = s.printed ?? beforeChange;
    const m = base && s.plan ? movesBetween(base, s.plan, s.finished + 1) : null;
    const n = m ? m.hosts.length + m.fams.length : 0;
    say("ok", n ? `Re-planned. Only the ${n === 1 ? "one change" : `${n} changes`} below need telling; everyone else stays where their card says.` : "Re-planned. Nobody else moves, and nothing needs reprinting.");
  }
  ctx.persist();
  render();
}

function runPage(): HTMLElement {
  const s = ev();
  const p = s.plan!;
  if (busy) return h("section", { className: "g-page" }, h("div", { className: "g-card run-now" }, h("p", { className: "big-round" }, h("span", { className: "spinner" }), " Updating the schedule…")));
  const current = isCurrent(s);
  return h("section", { className: "g-page run" },
    roundCard(p),
    runProblem ? h("div", { className: "msg error", role: "alert" }, runProblem) : null,
    current ? null : h("div", { className: "msg warn row spread" }, "The schedule is out of date.",
      h("button", { className: "button primary", onclick: () => applyChange(() => "") }, "Update the schedule")),
    current ? tellList(p) : null,
    changePanel(p),
    whoIsWhere(p),
    afterTheEvent(),
    h("div", { className: "g-run-more" },
      ctx.inPractice() || s.finished > 0 || s.night.roundTimes?.["1"] ? null
        : h("button", { className: "button", onclick: () => { practiceReturn = 3; ctx.practice(); } }, "Practice a cancellation first"),
      h("button", { className: "button", onclick: () => ctx.openNight() }, "More tools: check-in, room setup, QR code")));
}

function roundCard(p: EventPlan): HTMLElement {
  const s = ev();
  const st = status(s, nowMinutes());
  const r = st.round;
  const start = () => { startRound(s, r, nowMinutes()); logChange(s, ctx.now(), `Round ${r} started.`); ctx.persist(); render(); };
  let action: HTMLElement;
  if (st.phase === "before" || st.phase === "moving") action = h("button", { className: "button primary big wide", onclick: start }, `Start round ${r}`);
  else if (st.phase === "during") {
    action = h("button", { className: "button primary big wide", onclick: () => {
      endRound(s, r, nowMinutes());
      showNext = false;
      if (r < p.rounds) { finishRound(s, ctx.now()); justFinished = s.finished; } else logChange(s, ctx.now(), `Round ${r} finished. The event is over.`);
      ctx.persist();
      render();
    } }, r < p.rounds ? `End round ${r}: alumni move to round ${r + 1}` : `End round ${r}`);
  } else action = h("p", { className: "lead" }, "That's a wrap. Thank your alumni and your fams.");
  const startedAt = toMinutes(s.night.roundTimes?.[String(r)]?.start ?? "");
  return h("div", { className: "g-card run-now" },
    h("p", { className: "big-round" }, st.phase === "over" ? "All rounds done" : st.phase === "moving" ? `Next: round ${r} of ${p.rounds}` : `Round ${r} of ${p.rounds}`),
    st.phase === "during" && st.minutesLeft !== null ? h("p", { className: `clock-left ${st.minutesLeft < 0 ? "over" : ""}` },
      leftText(st.minutesLeft), startedAt !== null ? h("span", { className: "help" }, ` · ends ${shown(startedAt + s.roundMinutes)}`) : null) : null,
    action,
    justFinished === s.finished && st.phase === "moving" && s.finished > Math.max(0, ...p.lockedRounds) ? h("p", { className: "help" }, `Round ${s.finished} ended. `,
      h("button", { className: "button link", onclick: () => {
        s.finished -= 1; justFinished = null;
        const k = String(s.finished + 1);
        const rt = s.night.roundTimes ?? {};
        if (rt[k]) s.night = { ...s.night, roundTimes: { ...rt, [k]: { start: rt[k].start } } };
        logChange(s, ctx.now(), `Round ${s.finished + 1} un-finished.`);
        ctx.persist();
        render();
      } }, "Undo")) : null);
}

/** After a change: the alumni to tell, ticked off as they are told. */
function tellList(p: EventPlan): HTMLElement | null {
  const s = ev();
  const base = s.printed ?? beforeChange;
  if (!base) return null;
  const m = movesBetween(base, p, s.finished + 1);
  if (!m.hosts.length && !m.fams.length) return null;
  const told = new Set(s.night.told ?? []);
  const keyOf = (x: { round: number; hostId: string; now: string }) => `${x.round}|${x.hostId}|${x.now}`;
  const item = (key: string, text: string) => h("li", { className: told.has(key) ? "told" : "" },
    h("label", { className: "check light" }, (() => {
      const box = h("input", { type: "checkbox", checked: told.has(key) }) as HTMLInputElement;
      box.addEventListener("change", () => { toggleTold(s, key); ctx.persist(); render(); });
      return box;
    })(), ` ${text}`));
  const left = [...m.hosts.map(keyOf), ...m.fams.map((x) => `fam|${x.round}|${x.famId}`)].filter((k) => !told.has(k)).length;
  return h("section", { className: "g-card tell" },
    h("h2", {}, left ? `Tell these people (${left} to go)` : "Everyone has been told"),
    h("ul", { className: "told-list" }, m.hosts.map((x) => item(keyOf(x), x.text)), m.fams.map((x) => item(`fam|${x.round}|${x.famId}`, x.text))),
    m.hosts.length ? h("div", { className: "row" },
      h("button", { className: "button small", onclick: () => openPage(changeSlipsHtml(p, m.hosts, s.title, ctx.now())) }, "Print change slips"),
      h("button", { className: "button small", onclick: () => openPage(seatingChartHtml(p, s.title, null, false, ctx.now(), famLocations(s))) }, "Print the updated seating chart")) : null);
}

function whoIsWhere(p: EventPlan): HTMLElement {
  const s = ev();
  const cur = currentRound(s);
  const last = cur >= p.rounds;
  const r = showNext && !last ? cur + 1 : cur;
  const tables = tableNumbers(p);
  return h("section", { className: "g-card" },
    h("div", { className: "row spread" },
      h("h2", {}, r === cur ? `Round ${cur}: who is where` : `Round ${r}: who goes where`),
      last ? null : h("button", { className: "button small", onclick: () => { showNext = !showNext; render(); } }, showNext ? `Back to round ${cur}` : `See round ${cur + 1}`)),
    h("ul", { className: "g-where" }, [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]).map((f) => {
      const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
      const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
      const gone = (p.famAway[f.groupId] ?? []).includes(r);
      return h("li", { className: host ? "" : "empty" },
        h("span", { className: "tn" }, String(tables[f.groupId])),
        h("span", { className: "fam" }, f.name),
        h("span", { className: "who" }, gone ? "fam has left" : host ? hostLabel(host) : "no alum this round"));
    })));
}

function changePanel(p: EventPlan): HTMLElement {
  const s = ev();
  const cur = currentRound(s);
  const underWay = !!s.night.roundTimes?.[String(cur)]?.start && !s.night.roundTimes?.[String(cur)]?.end;
  const firstOpen = Math.min(p.rounds, underWay ? cur + 1 : cur);
  const openRounds = Array.from({ length: p.rounds - s.finished }, (_, i) => s.finished + 1 + i);
  const roundPick = (label: string, chosen: number) => h("select", { "aria-label": label },
    openRounds.map((r) => h("option", { value: r, selected: r === chosen }, `from round ${r}`))) as HTMLSelectElement;
  if (!change) {
    return h("section", { className: "g-card g-change" },
      h("button", { className: "button big wide", onclick: () => { change = "left"; runProblem = ""; render(); } }, "Someone changed?"),
      h("p", { className: "help" }, "Someone left, arrived late, or a fam sat at a different table. The app re-plans and tells you who to tell."));
  }
  const tabs: [typeof change, string][] = [["left", "An alum left or didn't come"], ["arrived", "An alum arrived"], ["table", "A fam is at another table"], ["famLeft", "A fam left"]];
  let form: HTMLElement;
  if (change === "left") {
    const here = s.hosts.filter((r) => named(r) && !(r.host_id in s.cancelHosts));
    const who = h("select", { "aria-label": "Alum who left" }, h("option", { value: "" }, "Who?"), here.map((r) => h("option", { value: r.host_id }, alumLabel(s, r.host_id)))) as HTMLSelectElement;
    const from = roundPick("Misses from round", firstOpen);
    form = h("div", { className: "row" }, who, from,
      h("button", { className: "button primary", onclick: () => applyChange(() => {
        if (!who.value) return "Choose who left.";
        cancelHost(s, who.value, Number(from.value), ctx.now(), Number(from.value) === 1 && !underWay);
        return "";
      }) }, "Re-plan"));
  } else if (change === "arrived") {
    const away = s.hosts.filter((r) => named(r) && r.host_id in s.cancelHosts);
    const who = h("select", { "aria-label": "Alum who arrived" }, h("option", { value: "" }, "Who?"),
      away.map((r) => h("option", { value: r.host_id }, alumLabel(s, r.host_id))), h("option", { value: "new" }, "Someone not on the list")) as HTMLSelectElement;
    const name = h("input", { type: "text", placeholder: "Their name", "aria-label": "New alum's name" }) as HTMLInputElement;
    const tags = h("input", { type: "text", placeholder: "What they can talk about", "aria-label": "New alum's interests" }) as HTMLInputElement;
    const from = roundPick("Hosts from round", firstOpen);
    const extra = h("div", { className: "row g-new" }, name, tags);
    extra.hidden = true;
    who.addEventListener("change", () => { extra.hidden = who.value !== "new"; });
    form = h("div", {}, h("div", { className: "row" }, who, from), extra,
      h("button", { className: "button primary", onclick: () => applyChange(() => {
        if (!who.value) return "Choose who arrived.";
        if (who.value === "new") return addLateHost(s, { table: name.value, person: name.value, tags: tags.value, from: Number(from.value) }, ctx.now());
        return joinLate(s, who.value, Number(from.value), ctx.now());
      }) }, "Re-plan"));
  } else if (change === "table") {
    const fam = h("select", { "aria-label": "Fam at another table" }, h("option", { value: "" }, "Which fam?"),
      s.fams.filter((r) => (r.fam_label ?? "").trim()).map((r) => h("option", { value: r.fam_id }, r.fam_label))) as HTMLSelectElement;
    const table = h("input", { type: "number", min: 1, step: 1, placeholder: "Table number", "aria-label": "Table they are at" }) as HTMLInputElement;
    form = h("div", { className: "row" }, fam, table,
      h("button", { className: "button primary", onclick: () => applyChange(() => (fam.value ? moveFamTable(s, fam.value, Number(table.value), ctx.now()) : "Choose the fam.")) }, "Re-plan"),
      h("p", { className: "help" }, "Don't move the students: the alumni come to them."));
  } else {
    const fam = h("select", { "aria-label": "Fam that left" }, h("option", { value: "" }, "Which fam?"),
      s.fams.filter((r) => (r.fam_label ?? "").trim() && !(r.fam_id in s.cancelFams)).map((r) => h("option", { value: r.fam_id }, r.fam_label))) as HTMLSelectElement;
    const from = roundPick("Fam misses from round", firstOpen);
    form = h("div", { className: "row" }, fam, from,
      h("button", { className: "button primary", onclick: () => applyChange(() => {
        if (!fam.value) return "Choose the fam.";
        cancelFam(s, fam.value, Number(from.value), ctx.now());
        return "";
      }) }, "Re-plan"));
  }
  return h("section", { className: "g-card g-change open" },
    h("div", { className: "row spread" }, h("h2", {}, "What changed?"), h("button", { className: "button small", onclick: () => { change = null; runProblem = ""; render(); } }, "Close")),
    h("div", { className: "g-segments", role: "tablist" }, tabs.map(([key, label]) =>
      h("button", { role: "tab", "aria-selected": change === key ? "true" : "false", className: change === key ? "now" : "", onclick: () => { change = key; runProblem = ""; render(); } }, label))),
    form,
    h("p", { className: "help" }, "Finished rounds never change."));
}

function afterTheEvent(): HTMLElement | null {
  const s = ev();
  if (status(s, nowMinutes()).phase !== "over") return null;
  return h("section", { className: "g-card" },
    h("h2", {}, "Before you go"),
    h("p", {}, "Jot down what you'd change, and save the event for next year's coordinator."),
    h("button", { className: "button primary", onclick: () => go(NEXT_YEAR) }, "Save for next year"));
}

// ----------------------------------------------------------------------
// Next year.
// ----------------------------------------------------------------------

function nextYearPage(): HTMLElement {
  const s = ev();
  const notes = h("textarea", { rows: 5, "aria-label": "Notes for next year", placeholder: "What worked, what didn't, which table is loud…" }) as HTMLTextAreaElement;
  notes.value = s.notes;
  notes.addEventListener("input", () => { s.notes = notes.value; ctx.persist(); });
  return h("section", { className: "g-page" },
    h("h1", {}, "Save for next year"),
    h("p", { className: "lead" }, "Next year's coordinator starts from your alumni, fams, and notes instead of a blank page."),
    field("Notes for next year", notes, "No student names here, please."),
    h("div", { className: "row" },
      h("button", { className: "button primary", onclick: () => {
        ctx.handOff();
        say("ok", "Downloaded the hand-off folder as a .zip file. Give it to next year's coordinator: they unzip it, choose Open a saved event, and pick the file ending in .rotation.json.");
        render();
      } }, "Download the hand-off folder"),
      h("button", { className: "button", onclick: () => {
        if (!sure) { sure = true; render(); return; }
        sure = false; ctx.removeStudentNames(); say("ok", "Student names removed."); render();
      } }, sure ? "Yes, delete student names from this event" : "Delete student names from this event")),
    h("p", { className: "help" }, "The folder leaves out student names, this year's arrival times, cancellations, and schedules, and puts moved tables back where they were planned. Its README lists what happened on the night, for context."),
    nav(3, null, () => undefined));
}

/** For tests and the app shell: go straight to a step. */
export function guidedStep(n: number): void { go(n); }
export const guidedFieldsCount = () => FIELDS.length;
