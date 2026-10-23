// The coordinator's app: four places and an end state, in event words.
//
//   Set up  ·  Schedule  ·  Print  ·  Run      (then Wrap up)
//
// Set up is three cards that collapse when done. The schedule is made on
// arrival and reads as a room plan; changes happen in Adjust. Print says what
// to print and why. Run is its own full-screen mode for a phone in one hand:
// the round, the clock, one button, and "Someone changed?", which turns any
// change into a list of people to tell. Everything else waits behind "More
// options" or the event menu (⋯). The full planner, with every option,
// stays at the address ending in #full.

import { h, openPage, readFile, replace } from "./dom";
import {
  EventState, FAM_COLUMNS, HOST_COLUMNS, applySpelling, checkInputs, famLocations, hasStarted, isCurrent, loadEvent,
  maxRounds, nearMisses, newEvent, normalizeState, normalizeTable, stepFreeFams,
} from "./event";
import { explainPairing } from "./explain";
import { hostCardsHtml, runSheetHtml, seatingChartHtml, tableNumbers, tableTentsHtml } from "./export";
import { FIELDS } from "./forms";
import { changeSlipsHtml, movesBetween } from "./moves";
import {
  addLateHost, cancelFam, cancelHost, currentRound, finishRound, joinLate, logChange, moveFamTable, recordActual, roomTables, toggleTold, whereIs,
} from "./night";
import { looksLikeHeader, parsePasted } from "./paste";
import { HostSettings, clearGrid, gridChanges, hostSettings, placeInGrid, renameInRules, setHostSettings, settingsWords } from "./people";
import type { EventPlan } from "./planning";
import { describeReprint, hostLabel, provenOptimal, reprintList } from "./planning";
import {
  backupPacketHtml, coordinatorGuideHtml, hostBadgesHtml, planSummaryHtml, printEverythingHtml, privacyNoteHtml, roleCardsHtml, runnerSheetsHtml,
} from "./printables";
import { csvRecords } from "./py";
import { CleanRow, dropExampleRows, groupStudentRows, matchColumns, renameColumns } from "./sheets";
import { endRound, leftText, nowMinutes, shown, startRound, status, toMinutes } from "./timing";

/** What the coordinator's pages need from the app around them. */
export interface GuidedCtx {
  get(): EventState;
  set(s: EventState): void;
  persist(): void;
  now(): string;
  /** Plan or update the schedule; returns a problem in plain words, or "" when it worked. */
  solve(keepPrinted: boolean): Promise<string>;
  /** The extra night tools: check-in, room setup, QR code for volunteers. */
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

type Place = "home" | "setup" | "schedule" | "print" | "run" | "wrap";
const TABS: [Place, string][] = [["setup", "Set up"], ["schedule", "Schedule"], ["print", "Print"], ["run", "Run"]];
const STEP_KEY = "rotation-optimizer:place";

let ctx: GuidedCtx;
let place: Place = "home";
let message: [string, string] | null = null; // [kind, text], shown once
let problems: string[] = [];
let menu = false;
let busy = false;
let sure = false;
let practiceReturn: Place | null = null;
// Set up
let openCard: "dinner" | "hosts" | "fams" | null = null;
let editing: "hosts" | "fams" | null = null;
let adding: "hosts" | "fams" | null = null;
let moreHosts = false;
let moreFams = false;
let noteFor: string | null = null;
let imported: { kind: "hosts" | "fams"; skipped: string[] | null; columns: string } | null = null;
// Schedule
let adjust = false;
let picked: { round: number; famId: string } | null = null;
let why = false;
let changed: string[] = [];
let moreSchedule = false;
// Print
let morePrint = false;
// Run
let change: "left" | "arrived" | "table" | "wrong" | "famLeft" | null = null;
let changeOpen = false;
let runProblem = "";
let runNote = "";
let beforeChange: EventPlan | null = null;
let showWhere = false;
let showNext = false;
let whereQuery = "";
let runMenu = false;
let justFinished: number | null = null;
let clockTimer = 0;

const ev = () => ctx.get();
const named = (r: CleanRow) => (r.table_label || r.host_name || "").trim();
const famsOf = (s: EventState) => s.fams.filter((r) => (r.fam_label ?? "").trim());
const hostsOf = (s: EventState) => s.hosts.filter(named);
const hasPeople = (s: EventState) => hostsOf(s).length > 0 || famsOf(s).length > 0;
const alumni = (n: number) => `${n} alum${n !== 1 ? "ni" : ""}`;
const famsN = (n: number) => `${n} fam${n !== 1 ? "s" : ""}`;

function remember(): void {
  try { localStorage.setItem(STEP_KEY, place); } catch { /* only a convenience */ }
}

function go(next: Place): void {
  place = next;
  changed = []; problems = []; picked = null; why = false; adjust = false; menu = false; runMenu = false;
  change = null; changeOpen = false; runProblem = ""; runNote = ""; editing = null; adding = null; noteFor = null; imported = null;
  remember();
  render(true);
  window.scrollTo(0, 0);
}

function say(kind: "ok" | "info" | "warn" | "error", text: string): void {
  message = [kind, text];
}

/** Coordinator words for the planner's sentences. */
function plain(text: string): string {
  return text.replace(/host tables?/g, (m) => (m.endsWith("s") ? "alumni" : "alum")).replace(/\bHost tables?\b/g, (m) => (m.endsWith("s") ? "Alumni" : "Alum"))
    .replace(/\btags?\b/g, "interests").replace(/\bhosts\b/g, "alumni").replace(/\bhost\b/g, "alum")
    .replace(/Pairing rule \d+: /, "").replace(/pairing rules?/g, "special arrangement").replace(/\b([Aa]) alum/g, "$1n alum")
    .replace(/cannot be met with these tables and rounds/g, "can't all happen together with these tables and rounds")
    .replace(/\bscore[sd]?\b/g, "match");
}

// ----------------------------------------------------------------------
// Status of each place: ready, done, or needs attention.
// ----------------------------------------------------------------------

type State = "locked" | "ready" | "done" | "attention";

function emptyFams(p: EventPlan): string[] {
  return p.fams.filter((f) => !p.assignments.some((a) => a.groupId === f.groupId)).map((f) => f.name);
}

function reprintNeeded(s: EventState): string[] {
  if (!s.printed || !s.plan || !isCurrent(s)) return [];
  return describeReprint(reprintList(s.printed, s.plan), s.plan);
}

const eventOver = (s: EventState) => !!s.plan && status(s, nowMinutes()).phase === "over";

function stateOf(t: Place): State {
  const s = ev();
  const lists = hostsOf(s).length > 0 && famsOf(s).length > 0;
  switch (t) {
    case "setup": return lists ? "done" : "ready";
    case "schedule":
      if (!lists) return "locked";
      if (!s.plan) return "ready";
      return !isCurrent(s) || emptyFams(s.plan).length ? "attention" : "done";
    case "print":
      if (!s.plan) return "locked";
      if (s.printed && !isCurrent(s)) return "attention";
      return s.printed ? (reprintNeeded(s).length ? "attention" : "done") : "ready";
    case "run":
      if (!s.plan) return "locked";
      return eventOver(s) ? "done" : "ready";
    default: return "ready";
  }
}

const STATE_WORDS: Record<State, string> = { locked: "not ready yet", ready: "ready", done: "done", attention: "needs attention" };

// ----------------------------------------------------------------------
// The frame.
// ----------------------------------------------------------------------

const LOGO = `<svg viewBox="0 0 40 40" width="28" height="28" aria-hidden="true"><rect x="2" y="2" width="36" height="36" rx="11" fill="var(--accent-wash)"/><circle cx="12" cy="15" r="4" fill="var(--accent)"/><circle cx="28" cy="15" r="4" fill="var(--accent)"/><circle cx="20" cy="28" r="4" fill="var(--accent)"/><path d="M16 13.5 Q20 10.5 24 13.5 M27 20 Q25.5 24.5 23.5 26.5 M16.5 26.5 Q13.5 24 12.8 20" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"/></svg>`;

function logo(): HTMLElement {
  const span = h("span", { className: "c-logo" });
  span.innerHTML = LOGO;
  return span;
}

function topBar(): HTMLElement {
  const s = ev();
  const practising = ctx.inPractice();
  return h("header", { className: "c-top" },
    h("div", { className: "c-bar" },
      logo(),
      h("strong", { className: "c-title" }, place === "home" ? "Rotation Dinner" : s.title || "Your dinner"),
      practising ? h("span", { className: "c-pill practice" }, "Practice ", h("button", { className: "c-link", onclick: () => ctx.endPractice() }, "End practice"))
        : place !== "home" ? h("span", { className: "c-saved", title: "Saved in this browser as you work." }, "Saved") : null,
      eventMenu()),
    place !== "home" ? h("nav", { className: "c-tabs", "aria-label": "Event" }, TABS.map(([key, label]) => {
      const st = stateOf(key);
      return h("button", {
        className: `c-tab ${place === key ? "now" : ""} ${st}`, disabled: st === "locked",
        "aria-current": place === key ? "page" : null, "aria-label": `${label}, ${STATE_WORDS[st]}`,
        onclick: () => go(key),
      }, h("span", { className: "c-tab-label" }, label), st === "done" ? h("span", { className: "c-mark", "aria-hidden": "true" }, "✓")
        : st === "attention" ? h("span", { className: "c-dot", "aria-hidden": "true" }) : null);
    }), eventOver(s) ? h("button", { className: `c-tab ${place === "wrap" ? "now" : ""}`, "aria-current": place === "wrap" ? "page" : null, onclick: () => go("wrap") },
      h("span", { className: "c-tab-label" }, "Wrap up")) : null) : null);
}

function eventMenu(): HTMLElement {
  const s = ev();
  return h("div", { className: "c-menu-wrap" },
    h("button", { className: "c-icon-button", "aria-label": "Event menu", "aria-expanded": menu ? "true" : "false", onclick: () => { menu = !menu; render(); if (menu) (document.querySelector(".c-menu button, .c-menu label") as HTMLElement | null)?.focus(); } }, "⋯"),
    menu ? h("div", { className: "c-menu" },
      place !== "home" ? h("button", { onclick: () => { menu = false; ctx.saveFile(); say("ok", "A copy of your event was downloaded. Keep it with your event files, or open it on another computer."); render(); } }, "Download a copy") : null,
      h("label", { for: "c-open", className: "c-menu-label", tabindex: 0 }, openInput("c-open"), "Open a saved event"),
      h("button", { onclick: () => { menu = false; go("home"); } }, "Start another dinner or see the example"),
      s.plan ? h("button", { onclick: () => go("wrap") }, "Wrap up and save for next year") : null,
      s.plan ? h("button", { onclick: () => { menu = false; ctx.openNight(); } }, "Extra night tools: check-in, room setup, QR code") : null,
      h("button", { onclick: () => { menu = false; openPage(coordinatorGuideHtml(s.title)); } }, "Print a one-page guide"),
      h("button", { onclick: () => { menu = false; openPage(privacyNoteHtml()); } }, "Privacy note for IT"),
      h("button", { onclick: () => { menu = false; ctx.offlineCopy(); } }, "Download the app for use without internet")) : null);
}

function openInput(id: string): HTMLElement {
  const input = h("input", { type: "file", accept: ".json,application/json", className: "visually-hidden", id, tabindex: -1 }) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    try {
      ctx.set(loadEvent(await readFile(f)));
      say("ok", `Opened ${f.name}.`);
      menu = false;
      go(ev().plan ? "schedule" : "setup");
    } catch {
      say("error", "That file is not a saved event. Choose a file you downloaded from this app.");
      render();
    }
  });
  return input;
}

/** A label that opens a hidden file input is reached with Tab and opened with Enter or Space. */
function keyOpens(label: HTMLElement): HTMLElement {
  label.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== "Enter" && k !== " ") return;
    e.preventDefault();
    (label.querySelector("input[type=file]") as HTMLInputElement | null)?.click();
  });
  return label;
}

function msg(): HTMLElement | null {
  if (!message) return null;
  const [kind, text] = message;
  message = null;
  if (kind !== "error") announce(text);
  return h("div", { className: `c-msg ${kind}`, role: kind === "error" ? "alert" : null }, text);
}

/** One quiet place for screen readers to hear what just happened. */
function announce(text: string): void {
  const el = document.getElementById("c-status");
  if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); }
}

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (menu && !t.closest(".c-menu-wrap")) { menu = false; render(); }
  if (runMenu && !t.closest(".c-run-menu")) { runMenu = false; render(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (menu) { menu = false; render(); (document.querySelector(".c-menu-wrap .c-icon-button") as HTMLElement | null)?.focus(); }
  if (runMenu) { runMenu = false; render(); (document.querySelector(".c-run-menu .c-icon-button") as HTMLElement | null)?.focus(); }
});

export function renderGuided(c: GuidedCtx): void {
  ctx = c;
  if (practiceReturn !== null && !ctx.inPractice()) { place = practiceReturn; practiceReturn = null; remember(); }
  if (place === "home" && hasPeople(ev())) {
    try {
      const saved = localStorage.getItem(STEP_KEY) as Place | null;
      if (saved && ["setup", "schedule", "print", "run", "wrap"].includes(saved)) place = saved === "setup" || saved === "wrap" || stateOf(saved) !== "locked" ? saved : "setup";
      if (place === "wrap" && !ev().plan) place = "setup";
    } catch { /* home */ }
  }
  render(true);
}

/** A key for the focused control, so focus comes back to it after a redraw. */
function focusKey(el: Element | null): string | null {
  if (!el || el === document.body) return null;
  const k = el.getAttribute("data-k") || el.id;
  if (k) return `#${k}`;
  const text = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").trim().slice(0, 60);
  return text ? `${el.tagName}|${text}` : null;
}

function restoreFocus(key: string | null): void {
  if (!key) return;
  const all = [...document.querySelectorAll<HTMLElement>("#app button, #app input, #app select, #app textarea, #app summary, #app [tabindex]")];
  all.find((el) => focusKey(el) === key)?.focus({ preventScroll: true });
}

function render(newPlace = false): void {
  const app = document.getElementById("app")!;
  const key = newPlace ? null : focusKey(document.activeElement);
  clearInterval(clockTimer);
  const s = ev();
  const running = place === "run" && !!s.plan;
  const body = place === "home" ? homePage() : place === "setup" ? setupPage() : place === "schedule" ? schedulePage()
    : place === "print" && s.plan ? printPage() : running ? runPage() : place === "wrap" ? wrapPage() : setupPage();
  replace(app, h("main", { className: `coord ${running ? "running" : ""}`, id: "main" },
    running ? null : topBar(), running ? null : msg(), body));
  const tab = TABS.find(([k]) => k === place)?.[1] ?? (place === "wrap" ? "Wrap up" : "");
  document.title = place === "home" ? "Rotation Dinner" : `${tab} · ${s.title || "Your dinner"}`;
  if (newPlace) (document.querySelector("#main h1") as HTMLElement | null)?.focus({ preventScroll: true });
  else restoreFocus(key);
  if (running) clockTimer = window.setInterval(tick, 15000);
}

/** Update only the clock on the Run screen, so nothing else moves under the coordinator's thumb. */
function tick(): void {
  const el = document.getElementById("c-clock");
  if (!el) return;
  const st = status(ev(), nowMinutes());
  if (st.phase === "during" && st.minutesLeft !== null) el.textContent = leftText(st.minutesLeft);
}

// ----------------------------------------------------------------------
// Home.
// ----------------------------------------------------------------------

const PICTURE = `<svg viewBox="0 0 520 150" role="img" aria-label="Students stay at their tables while alumni move to the next table each round">
<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--accent)"/></marker></defs>
<g fill="var(--surface)" stroke="var(--hairline-strong)" stroke-width="2"><circle cx="90" cy="80" r="40"/><circle cx="260" cy="80" r="40"/><circle cx="430" cy="80" r="40"/></g>
<g fill="var(--ink-soft)" font-size="15" font-weight="600" text-anchor="middle" font-family="inherit"><text x="90" y="86">1</text><text x="260" y="86">2</text><text x="430" y="86">3</text></g>
<g fill="var(--accent-wash)" stroke="var(--accent)" stroke-width="1.5">
<circle cx="62" cy="50" r="7"/><circle cx="118" cy="50" r="7"/><circle cx="62" cy="110" r="7"/><circle cx="232" cy="50" r="7"/><circle cx="288" cy="50" r="7"/><circle cx="288" cy="110" r="7"/>
<circle cx="402" cy="50" r="7"/><circle cx="458" cy="110" r="7"/><circle cx="402" cy="110" r="7"/></g>
<g fill="var(--accent)"><circle cx="118" cy="110" r="10"/><circle cx="232" cy="110" r="10"/><circle cx="458" cy="50" r="10"/></g>
<g fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="6 5" marker-end="url(#ah)"><path d="M132 118 Q175 140 216 120"/><path d="M246 122 Q360 150 448 68"/></g></svg>`;

function homePage(): HTMLElement {
  const s = ev();
  const going = hasPeople(s) && !ctx.inPractice();
  const picture = h("div", { className: "c-picture" });
  picture.innerHTML = PICTURE;
  const choice = (title: string, help: string, onclick: () => void, primary = false) =>
    h("button", { className: `c-choice ${primary ? "primary" : ""}`, onclick }, h("strong", {}, title), h("span", {}, help));
  return h("section", { className: "c-page c-home" },
    h("h1", { tabindex: -1 }, "Plan your rotation dinner"),
    h("p", { className: "c-lead" }, "Students stay at their table all night. Alumni move to a new table each round. Paste your two lists, print what you need, and run the night from your phone. If someone cancels, the app tells you who to move."),
    picture,
    h("div", { className: "c-choices" },
      going ? choice(`Continue ${s.title || "your dinner"}`, `${alumni(hostsOf(s).length)}, ${famsN(famsOf(s).length)}`, () => go(s.plan ? "schedule" : "setup"), true) : null,
      choice("Start a dinner", "Paste your alumni and fams from a spreadsheet.", () => { ctx.set(newEvent({ title: "", rounds: 3 })); openCard = "dinner"; go("setup"); }, !going),
      keyOpens(h("label", { className: "c-choice", for: "c-open-home", tabindex: 0 }, openInput("c-open-home"), h("strong", {}, "Open last year's file"), h("span", {}, "Or any event you saved."))),
      choice("Try an example", "A practice dinner. Nothing you do is kept.", async () => { practiceReturn = "home"; ctx.tryExample(); go("schedule"); await update(); })),
    h("p", { className: "c-fine" }, "Everything stays in this browser. Nothing is sent anywhere."));
}

// ----------------------------------------------------------------------
// Set up: three cards that collapse when done.
// ----------------------------------------------------------------------

interface Col { key: string; label: string; placeholder: string; wide?: boolean }
const ALUMNI_COLS: Col[] = [
  { key: "host_name", label: "Name", placeholder: "e.g. Sam Rivera" },
  { key: "tags", label: "Can talk about", placeholder: "law; policy", wide: true },
];
const TOPIC_COL: Col = { key: "table_label", label: "Field (under their name)", placeholder: "e.g. Law" };
const FAM_COLS: Col[] = [
  { key: "table_number", label: "Table", placeholder: "1" },
  { key: "fam_label", label: "Fam name", placeholder: "Fam Red" },
  { key: "interests", label: "Interested in", placeholder: "biology; pre-med", wide: true },
];
const FAM_EXTRA: Col[] = [
  { key: "students", label: "Students", placeholder: "Student 01; Student 02", wide: true },
  { key: "location", label: "Where in the room", placeholder: "by the stage" },
];

const blankRow = (kind: "hosts" | "fams"): CleanRow => Object.fromEntries((kind === "hosts" ? HOST_COLUMNS : FAM_COLUMNS).map((k) => [k, ""]));

/** Fill in what planning needs: an alum's field is their name when left blank. */
function tidy(s: EventState): void {
  for (const r of s.hosts) if (!(r.table_label ?? "").trim() && (r.host_name ?? "").trim()) r.table_label = r.host_name.trim();
  normalizeState(s);
}

/**
 * An alum's field (from a column like "Industry") is also the planner's name
 * for their table, so two alumni in the same field would clash. After an
 * import, such alumni are known by their own name, and the field joins their
 * interests so matching still uses it.
 */
function uniqueFields(s: EventState): void {
  const count = new Map<string, number>();
  for (const r of s.hosts) { const k = (r.table_label ?? "").trim().toLowerCase(); if (k) count.set(k, (count.get(k) ?? 0) + 1); }
  // If any field repeats, every alum is known by name, so printouts stay consistent.
  if (![...count.values()].some((n) => n > 1)) return;
  for (const r of s.hosts) {
    const field = (r.table_label ?? "").trim();
    if (!field || !(r.host_name ?? "").trim() || field === r.host_name.trim()) continue;
    const tags = (r.tags ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    if (!tags.some((t) => t.toLowerCase() === field.toLowerCase())) r.tags = [field.toLowerCase(), ...tags].join("; ");
    r.table_label = r.host_name.trim();
  }
}

const HEADERISH = /(name|fam|table|interest|major|topic|alum|email|industr|field|subject|student|number|^#|phone|talk|discuss|area)/i;

/** Column titles: the planner recognises them, or every cell reads like a title and none holds a number or a list. */
export function isHeaderRow(kind: "hosts" | "fams", row: string[], next: string[] | undefined): boolean {
  if (!next) return false;
  const mapping = matchColumns(row, kind);
  if (looksLikeHeader(row) && ((kind === "hosts" ? "table_label" : "fam_label") in mapping || "host_name" in mapping)) return true;
  const cells = row.filter((c) => c.trim());
  return cells.length > 0 && cells.every((c) => HEADERISH.test(c) && !/\d/.test(c) && !/[;,]/.test(c));
}

/**
 * Rows pasted or typed into a list. A title row is skipped (and said so);
 * with recognised titles the columns are matched by name, otherwise by
 * position: alumni are name then interests, fams are name then interests,
 * with a table number first when the first column is all numbers.
 */
function addRows(kind: "hosts" | "fams", grid: string[][]): void {
  const s = ev();
  const list = kind === "hosts" ? s.hosts : s.fams;
  const header = isHeaderRow(kind, grid[0], grid[1]);
  const mapping = header ? matchColumns(grid[0], kind) : {};
  const byName = header && ((kind === "hosts" ? "table_label" : "fam_label") in mapping || "host_name" in mapping);
  const body = (header ? grid.slice(1) : grid).filter((r) => r.some((c) => c.trim()));
  const width = Math.max(...body.map((r) => r.length));
  const numbered = kind === "fams" && body.every((r) => /^\d+$/.test((r[0] ?? "").trim()));
  const order = kind === "hosts"
    ? (width >= 3 ? ["host_name", "table_label", "tags"] : ["host_name", "tags"])
    : numbered ? ["table_number", "fam_label", "interests", "students"] : ["fam_label", "interests", "students"];
  for (const cells of body) {
    const row = blankRow(kind);
    if (byName) for (const [ours, theirs] of Object.entries(mapping)) row[ours] = cells[grid[0].indexOf(theirs)] ?? "";
    else order.forEach((k, j) => { row[k] = (cells[j] ?? "").trim(); });
    list.push(row);
  }
  tidy(s);
  if (kind === "hosts") uniqueFields(s);
  ctx.persist();
  const words: Record<string, string> = { host_name: "names", table_label: "fields", tags: "interests", fam_label: "fam names", interests: "interests", table_number: "table numbers", students: "students" };
  const used = byName ? Object.entries(mapping).filter(([k]) => words[k]).map(([k, v]) => `${words[k]} from "${v}"`).join(", ") : "";
  const usedCols = new Set(Object.values(mapping));
  const ignored = byName ? grid[0].filter((c) => c.trim() && !usedCols.has(c) && !/e-?mail|phone|mobile/i.test(c)) : [];
  imported = { kind, skipped: header ? grid[0] : null, columns: used + (ignored.length ? `. We didn't use: ${ignored.map((c) => `"${c}"`).join(", ")}. If they hold late arrivals or stairs, add those under More options` : "") };
  say("ok", `Added ${kind === "hosts" ? alumni(body.length) : famsN(body.length)}.`);
}

function undoHeader(): void {
  if (!imported?.skipped) return;
  const s = ev();
  const kind = imported.kind;
  const row = blankRow(kind);
  (kind === "hosts" ? ["host_name", "tags"] : ["fam_label", "interests"]).forEach((k, j) => { row[k] = imported!.skipped![j] ?? ""; });
  (kind === "hosts" ? s.hosts : s.fams).unshift(row);
  tidy(s);
  ctx.persist();
  imported = null;
  render();
}

function typedGrid(text: string): string[][] {
  const pasted = parsePasted(text);
  if (pasted && pasted.some((r) => r.length > 1)) return pasted;
  return text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^([^,:]+)[,:](.*)$/);
    return m ? [m[1].trim(), m[2].trim()] : [l];
  });
}

function pasteBox(kind: "hosts" | "fams"): HTMLElement {
  const example = kind === "hosts" ? "Sam Rivera, law; policy\nPriya Shah, medicine; biology" : "Fam Red, biology; pre-med\nFam Blue, law; history";
  const id = `c-paste-${kind}`;
  const box = h("textarea", { id, rows: 5, className: "c-paste", placeholder: example, "aria-describedby": `${id}-help` }) as HTMLTextAreaElement;
  const add = h("button", { className: "c-button primary", hidden: true, onclick: () => {
    const grid = typedGrid(box.value);
    if (!grid.length) return;
    addRows(kind, grid);
    adding = null;
    render();
  } }, "Add these");
  box.addEventListener("input", () => { add.hidden = !box.value.trim(); });
  box.addEventListener("paste", (e) => {
    const grid = parsePasted((e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "");
    if (!grid) return;
    e.preventDefault();
    addRows(kind, grid);
    adding = null;
    render();
  });
  return h("div", { className: "c-paste-zone" },
    h("label", { for: id, className: "c-label" }, kind === "hosts" ? "Paste or type your alumni" : "Paste or type your fams"),
    box,
    h("p", { id: `${id}-help`, className: "c-help" }, kind === "hosts"
      ? "Copy the rows from your spreadsheet, or type one alum per line: their name, then what they can talk about."
      : "Copy the rows from your spreadsheet, or type one fam per line: its name, then what its students are interested in."),
    h("div", { className: "c-row" }, add, uploadButton(kind),
      ev()[kind].length ? h("button", { className: "c-link", onclick: () => { adding = null; render(); } }, "Cancel") : null));
}

function uploadButton(kind: "hosts" | "fams"): HTMLElement {
  const id = `c-up-${kind}`;
  const input = h("input", { type: "file", accept: ".csv,text/csv", className: "visually-hidden", id, tabindex: -1 }) as HTMLInputElement;
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    const { rows, columns } = csvRecords(await readFile(f));
    const mapping = matchColumns(columns, kind);
    const required = kind === "hosts" ? "table_label" : "fam_label";
    if (!(required in mapping) && !(kind === "hosts" && "host_name" in mapping)) {
      say("error", `We couldn't tell which column holds the ${kind === "hosts" ? "alumni names" : "fam names"}. The columns are: ${columns.join(", ")}. Rename that column to "Name" and try again, or paste the rows instead.`);
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
    if (kind === "hosts") uniqueFields(s);
    ctx.persist();
    adding = null;
    say("ok", `Read ${kind === "hosts" ? alumni(clean.length) : famsN(clean.length)} from ${f.name}` + (grouped ? `, grouping ${grouped} student answers by fam.` : ".") + " Email and phone columns are never kept.");
    render();
  });
  return keyOpens(h("label", { className: "c-button", for: id, tabindex: 0 }, input, "Upload a file"));
}

function peopleList(kind: "hosts" | "fams", cols: Col[]): HTMLElement {
  const s = ev();
  const rows = () => (kind === "hosts" ? s.hosts : s.fams);
  const list = h("div", { className: "c-grid", "data-kind": kind });
  const draw = () => {
    replace(list,
      h("div", { className: "c-grid-row head", "aria-hidden": "true" }, cols.map((c) => h("span", { className: c.wide ? "wide" : "" }, c.label)), h("span", { className: "x" })),
      [...rows(), null].map((row, i) => {
        const r = row ?? ({} as CleanRow);
        const cells = cols.map((c) => {
          const shown = c.key === "table_label" && row && r.table_label === r.host_name ? "" : r[c.key] ?? "";
          const input = h("input", { type: "text", value: shown, placeholder: row ? (c.key === "table_label" ? "optional" : "") : c.placeholder, "aria-label": `${c.label}, row ${i + 1}`, className: c.wide ? "wide" : "", "data-col": c.key }) as HTMLInputElement;
          const before = r[c.key] ?? "";
          input.addEventListener("input", () => {
            if (!row) {
              const blank = blankRow(kind);
              blank[c.key] = input.value;
              rows().push(blank);
              normalizeState(s);
              ctx.persist();
              draw();
              const again = list.querySelectorAll<HTMLElement>(".c-grid-row:not(.head)")[i]?.querySelector<HTMLInputElement>(`[data-col="${c.key}"]`);
              again?.focus();
              again?.setSelectionRange(again.value.length, again.value.length);
              return;
            }
            r[c.key] = c.key === "table_label" && !input.value.trim() ? r.host_name ?? "" : input.value;
            ctx.persist();
          });
          input.addEventListener("change", () => {
            if (row && (c.key === "table_label" || c.key === "fam_label")) renameInRules(s, kind === "hosts" ? "host" : "fam", before, input.value);
            ctx.persist();
          });
          input.addEventListener("keydown", (e) => {
            if ((e as KeyboardEvent).key !== "Enter") return;
            e.preventDefault();
            list.querySelectorAll<HTMLElement>(".c-grid-row:not(.head)")[i + 1]?.querySelector<HTMLInputElement>(`[data-col="${c.key}"]`)?.focus();
          });
          return input;
        });
        return h("div", { className: `c-grid-row ${row ? "" : "new"}` }, cells,
          row ? h("button", { className: "c-x", "aria-label": `Remove row ${i + 1}`, onclick: () => { rows().splice(i, 1); ctx.persist(); draw(); } }, "×") : h("span", { className: "x" }));
      }));
  };
  draw();
  return list;
}

function readList(kind: "hosts" | "fams"): HTMLElement {
  const s = ev();
  const split = (t: string) => (t ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean).join(", ");
  if (kind === "hosts") {
    return h("ul", { className: "c-read", "data-kind": "hosts" }, hostsOf(s).map((r) => h("li", {},
      h("span", { className: "who" }, r.host_name || r.table_label),
      h("span", { className: "what" }, [r.table_label && r.host_name && r.table_label !== r.host_name ? r.table_label : "", split(r.tags)].filter(Boolean).join(" · ") || "no interests yet"),
      settingsWords(s, r.host_id).map((w) => h("span", { className: "c-tag" }, w)))));
  }
  const tables = roomTables(s);
  return h("ul", { className: "c-read", "data-kind": "fams" }, famsOf(s).map((r) => h("li", {},
    h("span", { className: "c-num" }, String(tables[r.fam_id] ?? "")),
    h("span", { className: "who" }, r.fam_label),
    h("span", { className: "what" }, split(r.interests) || "no interests yet"),
    /^(y|yes|true|1)$/i.test((r.step_free ?? "").trim()) ? h("span", { className: "c-tag" }, "step-free") : null)));
}

function setupCard(key: "dinner" | "hosts" | "fams", title: string, summary: string, done: boolean, body: () => (HTMLElement | null)[]): HTMLElement {
  const isOpen = openCard === key || !done;
  return h("section", { className: `c-card c-setup ${done ? "done" : ""} ${isOpen ? "open" : ""}`, "data-card": key },
    h("h2", { className: "c-card-h" }, h("button", { className: "c-card-head", "aria-expanded": isOpen ? "true" : "false", "data-k": `card-${key}`, disabled: !done, onclick: () => { openCard = isOpen ? null : key; render(); } },
      h("span", { className: `c-check ${done ? "on" : ""}`, "aria-hidden": "true" }, done ? "✓" : ""),
      h("span", { className: "c-card-title" }, title),
      h("span", { className: "c-card-summary" }, done && !isOpen ? summary : ""),
      done ? h("span", { className: "c-chev", "aria-hidden": "true" }, isOpen ? "▴" : "▾") : null)),
    isOpen ? h("div", { className: "c-card-body" }, ...body()) : null);
}

function more(open: boolean, toggle: () => void, label: string, ...body: (HTMLElement | null | (HTMLElement | null)[])[]): HTMLElement {
  return h("div", { className: "c-more" },
    h("button", { className: "c-more-head", "aria-expanded": open ? "true" : "false", "data-k": `more-${label}-${place}`, onclick: toggle }, label, h("span", { "aria-hidden": "true" }, open ? " ▴" : " ▾")),
    open ? h("div", { className: "c-more-body" }, ...body) : null);
}

function settingsPanel(row: CleanRow): HTMLElement {
  const s = ev();
  const n = s.rounds;
  const x = hostSettings(s, row.host_id);
  const who = row.host_name || row.table_label;
  const save = (next: Partial<HostSettings>) => { tidy(s); setHostSettings(s, row.host_id, { ...hostSettings(s, row.host_id), ...next }); ctx.persist(); render(); };
  const roundSel = (label: string, value: number, onPick: (v: number) => void) => {
    const sel = h("select", { "aria-label": label }, Array.from({ length: n }, (_, k) => h("option", { value: k + 1, selected: k + 1 === value }, `round ${k + 1}`))) as HTMLSelectElement;
    sel.addEventListener("change", () => onPick(Number(sel.value)));
    return sel;
  };
  const check = (label: string, on: boolean, onPick: (v: boolean) => void, help: string) => {
    const box = h("input", { type: "checkbox", checked: on }) as HTMLInputElement;
    box.addEventListener("change", () => onPick(box.checked));
    return h("label", { className: "c-checkline" }, box, h("span", {}, label, h("span", { className: "c-help inline" }, help)));
  };
  const famNames = famsOf(s).map((r) => r.fam_label);
  const famPick = (label: string, chosen: string[], onPick: (v: string[]) => void) => {
    const sel = h("select", { "aria-label": `${label}, for ${who}` }, h("option", { value: "" }, "Choose a fam…"), famNames.filter((f) => !chosen.includes(f)).map((f) => h("option", { value: f }, f))) as HTMLSelectElement;
    sel.addEventListener("change", () => { if (sel.value) onPick([...chosen, sel.value]); });
    return h("div", { className: "c-row" }, h("span", {}, label), chosen.map((f) => h("button", { className: "c-chip", "aria-label": `Remove ${f}`, onclick: () => onPick(chosen.filter((y) => y !== f)) }, `${f} ×`)), famNames.length ? sel : h("span", { className: "c-help" }, "Add fams first."));
  };
  const stepFree = x.stepFree ? h("fieldset", { className: "c-stepfree" },
    h("legend", { className: "c-help" }, "Which fam tables can be reached without stairs?"),
    famsOf(s).map((r) => {
      const box = h("input", { type: "checkbox", checked: /^(y|yes|true|1)$/i.test((r.step_free ?? "").trim()) }) as HTMLInputElement;
      box.addEventListener("change", () => { r.step_free = box.checked ? "yes" : ""; ctx.persist(); render(); });
      return h("label", { className: "c-checkline light" }, box, h("span", {}, r.fam_label));
    })) : null;
  return h("div", { className: "c-inset" },
    h("div", { className: "c-row" }, h("span", {}, `${who} is here from`), roundSel(`${who} is here from round`, x.from, (v) => save({ from: v, until: Math.max(v, x.until) })),
      h("span", {}, "to"), roundSel(`${who} is here until round`, x.until, (v) => save({ until: v, from: Math.min(v, x.from) }))),
    check("Can't use stairs", x.stepFree, (v) => save({ stepFree: v }), " Only visits step-free tables."),
    stepFree,
    check("Stays at one table all night", x.stays, (v) => save({ stays: v }), " For someone who can't move between tables."),
    famPick("Must meet", x.must, (v) => save({ must: v })),
    famPick("Never meets", x.never, (v) => save({ never: v })),
    h("button", { className: "c-button", onclick: () => { noteFor = null; render(); } }, "Done"));
}

function setupPage(): HTMLElement {
  const s = ev();
  const nHosts = hostsOf(s).length, nFams = famsOf(s).length;
  const name = h("input", { id: "c-name", type: "text", value: s.title, placeholder: "Alumni dinner" }) as HTMLInputElement;
  name.addEventListener("input", () => { s.title = name.value; ctx.persist(); const t = document.querySelector(".c-title"); if (t) t.textContent = s.title || "Your dinner"; });
  const rounds = h("select", { id: "c-rounds" }, [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: n, selected: n === s.rounds }, `${n} round${n !== 1 ? "s" : ""}`))) as HTMLSelectElement;
  rounds.addEventListener("change", () => { s.rounds = Number(rounds.value); s.finished = Math.min(s.finished, s.rounds - 1); ctx.persist(); });
  const dinnerDone = nHosts > 0 || nFams > 0 || !!s.title.trim();
  const importNote = (kind: "hosts" | "fams") => imported && imported.kind === kind && (imported.skipped || imported.columns) ? h("p", { className: "c-note" },
    imported.skipped ? ["Your first row looked like column titles, so it was skipped. ", h("button", { className: "c-link", onclick: undoHeader }, "It's a real row: add it back")] : null,
    imported.columns ? h("span", { className: "c-help" }, ` We used ${imported.columns}.`) : null) : null;
  const special = hostsOf(s).filter((r) => settingsWords(s, r.host_id).length);
  const pick = h("select", { "aria-label": "Choose an alum" }, h("option", { value: "" }, "Choose an alum…"),
    hostsOf(s).map((r) => h("option", { value: r.host_id, selected: r.host_id === noteFor }, r.host_name || r.table_label))) as HTMLSelectElement;
  pick.addEventListener("change", () => { noteFor = pick.value || null; render(); });
  const noteRow = noteFor ? s.hosts.find((r) => r.host_id === noteFor) : null;
  const listButtons = (kind: "hosts" | "fams", n: number) => n && adding !== kind ? h("div", { className: "c-row" },
    editing === kind ? h("button", { className: "c-button primary", onclick: () => { tidy(s); ctx.persist(); editing = null; render(); } }, "Done editing")
      : h("button", { className: "c-button", "data-k": `edit-${kind}`, onclick: () => { editing = kind; render(); } }, kind === "hosts" ? "Edit alumni" : "Edit fams"),
    editing ? null : h("button", { className: "c-link", onclick: () => { adding = kind; render(); } }, kind === "hosts" ? "Paste more alumni" : "Paste more fams")) : null;
  return h("section", { className: "c-page" },
    h("h1", { tabindex: -1 }, "Set up"),
    problems.length ? h("div", { className: "c-msg error", role: "alert" }, h("strong", {}, "Before making the schedule:"), h("ul", {}, problems.map((p) => h("li", {}, plain(p))))) : null,
    setupCard("dinner", "Your dinner", `${s.title || "Alumni dinner"} · ${s.rounds} round${s.rounds !== 1 ? "s" : ""}`, dinnerDone, () => [
      h("div", { className: "c-fields" },
        h("div", { className: "c-field" }, h("label", { for: "c-name", className: "c-label" }, "Name"), name),
        h("div", { className: "c-field" }, h("label", { for: "c-rounds", className: "c-label" }, "Rounds"), rounds,
          h("span", { className: "c-help" }, "Each round, every alum moves to a new fam."))),
      dinnerDone ? null : h("button", { className: "c-button primary", onclick: () => { if (!s.title.trim()) s.title = "Alumni dinner"; ctx.persist(); openCard = null; render(); } }, "Next: your alumni"),
    ]),
    setupCard("hosts", "Alumni", alumni(nHosts) + (special.length ? ` · ${special.length} with special arrangements` : ""), nHosts > 0, () => [
      importNote("hosts"),
      editing === "hosts" ? peopleList("hosts", moreHosts ? [...ALUMNI_COLS, TOPIC_COL] : ALUMNI_COLS) : nHosts && adding !== "hosts" ? readList("hosts") : pasteBox("hosts"),
      listButtons("hosts", nHosts),
      nHosts ? more(moreHosts, () => { moreHosts = !moreHosts; render(); }, "More options",
        h("p", {}, "Anyone arriving late, leaving early, who can't use stairs, or who should or shouldn't meet a fam?"),
        h("div", { className: "c-row" }, pick),
        noteRow ? settingsPanel(noteRow) : null,
        special.length ? h("ul", { className: "c-special" }, special.map((r) => h("li", {}, h("strong", {}, r.host_name || r.table_label), " ", settingsWords(s, r.host_id).join(", ")))) : null,
        editing === "hosts" ? null : h("button", { className: "c-link", onclick: () => { editing = "hosts"; render(); } }, "Show a field under each alum's name")) : null,
    ]),
    setupCard("fams", "Fams", famsN(nFams), nFams > 0, () => [
      importNote("fams"),
      editing === "fams" ? peopleList("fams", moreFams ? [...FAM_COLS, ...FAM_EXTRA] : FAM_COLS) : nFams && adding !== "fams" ? readList("fams") : pasteBox("fams"),
      listButtons("fams", nFams),
      nFams ? more(moreFams, () => { moreFams = !moreFams; render(); }, "More options",
        h("p", {}, "Student names print a find-your-table page. Where in the room prints on alumni cards."),
        editing === "fams" ? null : h("button", { className: "c-link", onclick: () => { editing = "fams"; render(); } }, "Add students or where each table is")) : null,
    ]),
    h("div", { className: "c-actions" },
      h("span", { className: "c-help" }, !nHosts ? "Add your alumni to continue." : !nFams ? "Add your fams to continue." : ""),
      h("button", { className: "c-button primary big", disabled: !nHosts || !nFams || busy, onclick: async () => {
        tidy(s);
        problems = [...new Set(checkInputs({ ...s, rules: [] }).problems)];
        const stairs = s.hosts.find((r) => hostSettings(s, r.host_id).stepFree);
        if (stairs && !stepFreeFams(s).length) { problems.push(`${stairs.host_name || stairs.table_label} can't use stairs: tick at least one step-free table under Alumni, More options.`); moreHosts = true; noteFor = stairs.host_id; openCard = "hosts"; }
        if (s.rounds > maxRounds(s)) problems.push(`With ${alumni(nHosts)} and ${famsN(nFams)}, at most ${maxRounds(s)} rounds can run without a fam meeting the same alum twice. Choose fewer rounds.`);
        if (problems.length) { render(); (document.querySelector("#main .c-msg.error") as HTMLElement | null)?.scrollIntoView({ block: "center" }); return; }
        if (!s.title.trim()) s.title = "Alumni dinner";
        ctx.persist();
        go("schedule");
        await update();
      } }, s.plan ? "Update the schedule" : "Make the schedule")));
}

// ----------------------------------------------------------------------
// Schedule: is this good enough to run?
// ----------------------------------------------------------------------

async function update(keepAll = false): Promise<void> {
  const s = ev();
  const before = s.plan;
  busy = true;
  render();
  const err = await ctx.solve(keepAll || hasStarted(s) || s.printed !== null);
  busy = false;
  if (err) say("error", plain(err));
  else if (before && s.plan) changed = movesBetween(before, s.plan, s.finished + 1).hosts.map((x) => x.text);
  else changed = [];
  render();
}

function summary(p: EventPlan): HTMLElement {
  const met = p.fams.map((f) => new Set(p.assignments.filter((a) => a.groupId === f.groupId).map((a) => a.hostId)).size);
  const lo = Math.min(...met), hi = Math.max(...met);
  const anyInterests = p.fams.some((f) => f.interests.length) && p.hosts.some((x) => x.tags.length);
  const weak = p.assignments.filter((a) => a.score === 0).length;
  const lines = [
    lo === hi ? `Every fam meets ${alumni(lo)}, a different one each round.` : `Each fam meets ${lo} to ${alumni(hi)}, a different one each round.`,
    anyInterests && weak ? `${weak === 1 ? "One pairing is" : `${weak} of ${p.assignments.length} pairings are`} a weaker match: the alum and fam share no interest word.` +
      (weak * 2 > p.assignments.length ? " Matches only count identical words, so using the same words in both lists (for example \"computer science\" in both, not \"CS\" in one) gives better matches." : "") : "",
    provenOptimal(p) ? (p.keptSlots !== null ? "This is the best update, changing as little as possible." : "With these words, no other schedule shares more interests.") : "",
  ].filter(Boolean);
  return h("div", { className: "c-answer" }, h("span", { className: "c-answer-mark", "aria-hidden": "true" }, "✓"),
    h("div", {}, h("p", { className: "c-answer-main" }, lines[0]), lines.slice(1).map((l) => h("p", { className: "c-help" }, l))));
}

function needsYou(p: EventPlan): HTMLElement[] {
  const s = ev();
  const out: HTMLElement[] = [];
  for (const f of emptyFams(p)) out.push(h("li", {}, `${f} has no alum in any round. Tap Adjust and move an alum there, or add one in Set up.`));
  const free = stepFreeFams(s);
  for (const [hostId, rs] of Object.entries(p.hostBreaks)) {
    const x = hostSettings(s, hostId);
    if (!x.stepFree) continue;
    const who = p.hosts.find((y) => y.hostId === hostId)!;
    const sitOut = rs.filter((r) => r >= x.from && r <= x.until && !(p.hostAway[hostId] ?? []).includes(r));
    const here = Array.from({ length: p.rounds }, (_, k) => k + 1).filter((r) => r >= x.from && r <= x.until && !(p.hostAway[hostId] ?? []).includes(r)).length;
    if (sitOut.length && here > free.length) out.push(h("li", {}, `${who.person || who.name} sits out round${sitOut.length !== 1 ? "s" : ""} ${sitOut.join(" and ")}: only ${free.length} table${free.length !== 1 ? "s are" : " is"} step-free. `,
      h("button", { className: "c-link", onclick: () => { go("setup"); moreHosts = true; noteFor = hostId; openCard = "hosts"; render(); } }, "Mark more tables step-free")));
  }
  return out;
}

function schedulePage(): HTMLElement {
  const s = ev();
  const p = s.plan;
  if (busy) return h("section", { className: "c-page" }, h("h1", { tabindex: -1 }, "Schedule"), h("p", { className: "c-lead" }, h("span", { className: "spinner" }), " Seating everyone…"));
  if (!p) return h("section", { className: "c-page" }, h("h1", { tabindex: -1 }, "Schedule"), h("p", { className: "c-lead" }, "Make the schedule from your lists."),
    h("button", { className: "c-button primary big", onclick: () => update() }, "Make the schedule"));
  const current = isCurrent(s);
  const attention = needsYou(p);
  const mine = gridChanges(s);
  const tips = nearMisses(s.hosts, s.fams);
  return h("section", { className: "c-page" },
    h("div", { className: "c-head-row" }, h("h1", { tabindex: -1 }, "Schedule"),
      current ? h("button", { className: `c-button ${adjust ? "primary" : ""}`, "aria-pressed": adjust ? "true" : "false", "data-k": "adjust", onclick: () => { adjust = !adjust; picked = null; why = false; render(); } }, adjust ? "Done adjusting" : "Adjust") : null),
    current ? null : h("div", { className: "c-msg warn c-row spread" }, "Your lists changed since this schedule was made.",
      h("button", { className: "c-button primary", disabled: busy, onclick: () => update() }, "Update the schedule")),
    summary(p),
    changed.length ? h("div", { className: "c-msg info" }, h("strong", {}, "What moved:"), h("ul", {}, changed.map((c) => h("li", {}, c)))) : null,
    attention.length ? h("div", { className: "c-msg warn" }, h("strong", {}, "Needs you"), h("ul", {}, attention)) : null,
    adjust ? adjustBar(p) : null,
    roomPlan(p, current),
    whoSitsOut(p),
    adjust && mine.length ? h("p", { className: "c-help" }, `${alumni(mine.length)} placed by hand. `,
      h("button", { className: "c-link", onclick: async () => { clearGrid(s); ctx.persist(); await update(); } }, "Undo my changes")) : null,
    more(moreSchedule, () => { moreSchedule = !moreSchedule; render(); }, "More options",
      h("p", { className: "c-help" }, "To change who sits where, tap Adjust above."),
      tips.length ? h("div", {}, h("p", {}, "These look like the same interest, but only identical words count as a match:"),
        tips.map((m) => h("div", { className: "c-row" }, h("span", {}, m.spellings.join(" and ")),
          h("button", { className: "c-button", onclick: async () => { applySpelling(s, m); ctx.persist(); await update(); } }, `Use "${m.suggestion}" for all`)))) : null,
      p.warnings.length ? h("details", {}, h("summary", {}, "Notes about this schedule"), h("ul", {}, p.warnings.map((w) => h("li", {}, warningWords(w))))) : null,
      !adjust && mine.length ? h("button", { className: "c-link", onclick: async () => { clearGrid(s); ctx.persist(); await update(); } }, `Undo the ${mine.length} change${mine.length !== 1 ? "s" : ""} you made by hand`) : null),
    h("div", { className: "c-actions" }, h("span"), current ? h("button", { className: "c-button primary big", onclick: () => go("print") }, "Looks good: print") : null));
}

function warningWords(w: string): string {
  if (w.startsWith("Host tags that no fam lists") || w.startsWith("Fam interests that no host lists")) {
    const list = w.slice(w.indexOf(": ") + 2).replace(/\.$/, "");
    return w.startsWith("Host") ? `No fam is interested in: ${list}.` : `No alum talks about: ${list}.`;
  }
  return plain(w.replace(/^Fairness check: /, ""))
    .replace(/gets no alum or a 0-match alum in (\d) rounds/, "has no alum, or a weaker match, in $1 rounds")
    .replace(/, no shared interests/g, ", weaker match")
    .replace(/ Consider a must meet rule for this fam\./, "").replace(/ or turn on "No fam gets more than one weak round"/, "")
    .replace(/matches (\d+) in total, far below the typical fam \((\d+)\)\./, "matches its alumni less well than the other fams do.");
}

function adjustBar(p: EventPlan): HTMLElement {
  if (!picked) return h("div", { className: "c-adjust" }, h("p", {}, "Tap an alum, then another alum or an empty seat in the same round. They swap, and everything else stays where it can."));
  const a = p.assignments.find((x) => x.round === picked!.round && x.groupId === picked!.famId);
  const host = a ? p.hosts.find((x) => x.hostId === a.hostId) : null;
  const who = host ? host.person || host.name : "This empty seat";
  return h("div", { className: "c-adjust", role: "status" },
    h("p", {}, h("strong", {}, `${who}, round ${picked.round}. `), `Now tap where they should go in round ${picked.round}.`),
    blockedReasons(p).length ? h("ul", { className: "c-help" }, blockedReasons(p).map((x) => h("li", {}, x))) : null,
    h("div", { className: "c-row" },
      host ? h("button", { className: "c-link", "aria-expanded": why ? "true" : "false", onclick: () => { why = !why; render(); } }, why ? "Hide why" : `Why is ${who} here?`) : null,
      h("button", { className: "c-link", onclick: () => { picked = null; why = false; render(); } }, "Cancel")),
    why && host ? whyBox(p) : null);
}

/** Why some seats in the picked round are not possible, once each. */
function blockedReasons(p: EventPlan): string[] {
  if (!picked) return [];
  const out = new Set<string>();
  for (const f of p.fams) {
    if (f.groupId === picked.famId) continue;
    const why = swapBlock(p, picked.round, picked.famId, f.groupId);
    if (why) out.add(`Seats marked "not possible": ${why}`);
  }
  return [...out];
}

/** The schedule as a room plan: one row per table, one column per round. */
function roomPlan(p: EventPlan, current: boolean): HTMLElement {
  const s = ev();
  const tables = tableNumbers(p);
  const list = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const rounds = Array.from({ length: p.rounds }, (_, k) => k + 1);
  const locked = new Set(p.lockedRounds);
  const byHand = new Set(gridChanges(s).map((r) => `${r.rounds}|${(r.fam ?? "").toLowerCase()}|${(r.host_table ?? "").toLowerCase()}`));
  return h("div", { className: `c-plan ${adjust ? "adjusting" : ""}`, role: "table", "aria-label": "Who sits at each table, each round", style: `--rounds: ${p.rounds}` },
    h("div", { className: "c-plan-row head", role: "row" }, h("span", { role: "columnheader" }, "Table"), rounds.map((r) => h("span", { role: "columnheader" }, `Round ${r}${r <= s.finished ? " (done)" : ""}`))),
    list.map((f) => h("div", { className: "c-plan-row", role: "row" },
      h("span", { className: "c-plan-fam", role: "rowheader" }, h("span", { className: "c-num" }, String(tables[f.groupId])), h("span", {}, f.name)),
      rounds.map((r) => {
        const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
        const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
        const gone = (p.famAway[f.groupId] ?? []).includes(r);
        const weak = !!a && a.score === 0 && f.interests.length > 0;
        const label = gone ? "fam not here" : host ? host.person || host.name : "empty seat";
        if (!adjust) {
          return h("span", { role: "cell", className: `c-seat ${host ? "" : "empty"}`, "data-round": r },
            h("span", { className: "c-round-tag", "aria-hidden": "true" }, `R${r}`), h("span", { className: "c-seat-name" }, label),
            weak ? h("span", { className: "c-weak", title: "Weaker match" }, h("span", { className: "visually-hidden" }, ", weaker match")) : null);
        }
        const pinned = !!host && byHand.has(`${r}|${f.name.toLowerCase()}|${host.name.toLowerCase()}`);
        const isPicked = picked?.round === r && picked.famId === f.groupId;
        const can = current && !locked.has(r) && r > s.finished && !gone && !busy;
        const blocked = !!picked && picked.round === r && !isPicked && can ? swapBlock(p, r, picked.famId, f.groupId) : "";
        return h("span", { role: "cell", className: "c-seat-cell" },
          h("button", {
            className: `c-seat-button ${host ? "" : "empty"} ${isPicked ? "picked" : ""} ${picked && picked.round === r && !isPicked && !blocked ? "target" : ""} ${blocked ? "blocked" : ""}`,
            disabled: !can, "aria-disabled": blocked ? "true" : null, "aria-pressed": isPicked ? "true" : "false", "data-round": r,
            "aria-label": `Table ${tables[f.groupId]}, ${f.name}, round ${r}: ${label}${weak ? ", weaker match" : ""}${pinned ? ", placed by hand" : ""}${blocked ? `. Not possible: ${blocked}` : ""}`,
            "data-k": `seat-${r}-${f.groupId}`, title: blocked || null,
            onclick: () => { if (blocked) { say("info", blocked); render(); return; } tapSeat(p, r, f.groupId); },
          }, h("span", { className: "c-round-tag", "aria-hidden": "true" }, `R${r}`), h("span", { className: "c-seat-name" }, label), pinned ? h("span", { className: "c-pin", "aria-hidden": "true" }, "placed") : null,
            blocked ? h("span", { className: "c-blocked-note", "aria-hidden": "true" }, "not possible") : null));
      }))));
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
  return lines.length ? h("p", { className: "c-help" }, h("strong", {}, "Not at a table: "), lines.join(" · ")) : null;
}

async function tapSeat(p: EventPlan, r: number, famId: string): Promise<void> {
  if (!picked || picked.round !== r) { picked = { round: r, famId }; why = false; render(); return; }
  if (picked.famId === famId) { picked = null; why = false; render(); return; }
  const from = picked.famId;
  const s = ev();
  const rulesBefore = structuredClone(s.rules);
  const a = p.assignments.find((x) => x.round === r && x.groupId === from);
  const b = p.assignments.find((x) => x.round === r && x.groupId === famId);
  const famA = p.fams.find((f) => f.groupId === from)!.name, famB = p.fams.find((f) => f.groupId === famId)!.name;
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
    if (elsewhere.length) changed = [...here, `So no fam meets the same alum twice, ${elsewhere.length} other change${elsewhere.length !== 1 ? "s were" : " was"} needed:`, ...elsewhere];
  }
  if (!isCurrent(s)) {
    s.rules = rulesBefore;
    ctx.persist();
    const moves: [string, string][] = [];
    if (a) moves.push([a.hostId, famId]);
    if (b) moves.push([b.hostId, from]);
    say("error", `${refusal(p, r, moves)} Nothing was changed.`);
    changed = [];
    render();
  }
}

function swapBlock(p: EventPlan, r: number, fromFam: string, toFam: string): string {
  const a = p.assignments.find((x) => x.round === r && x.groupId === fromFam);
  const b = p.assignments.find((x) => x.round === r && x.groupId === toFam);
  const moves: [string, string][] = [];
  if (a) moves.push([a.hostId, toFam]);
  if (b) moves.push([b.hostId, fromFam]);
  const reason = refusal(p, r, moves);
  return reason.startsWith("That change") ? "" : reason;
}

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
  return "That change can't happen together with everyone's arrangements while no fam meets the same alum twice.";
}

function whyBox(p: EventPlan): HTMLElement {
  const { round, famId } = picked!;
  const x = explainPairing(p, round, famId);
  const s = ev();
  const limited = (label: string) => s.rules.some((r) => (r.host_table ?? "").toLowerCase() === label.toLowerCase() && ["needs step-free", "stays with", "never meet"].includes(r.rule));
  const lines = x.lines.filter((l) => {
    if (l.startsWith("The schedule maximizes")) return false;
    const m = l.match(/^The best match for .+ is (.+?) \(score/);
    return !(m && limited(m[1]));
  });
  return h("div", { className: "c-why" },
    lines.map((l) => h("p", {}, plain(l.replace(/ \(score \d+\)/, "").replace(/, so the pairing scores \d+\./, ".")
      .replace(/ shares none of (.+)'s (fields|interests), so the pairing scores 0\./, " has nothing in common with $1.")))),
    lines.some((l) => l.startsWith("The best match")) ? h("p", { className: "c-help" }, "The schedule balances every fam at once, so a fam sometimes gets its second choice.") : null);
}

// ----------------------------------------------------------------------
// Print: what do I need to print?
// ----------------------------------------------------------------------

interface Doc { label: string; purpose: string; pages: number; make: () => string }

function docs(s: EventState, p: EventPlan): Doc[] {
  const loc = famLocations(s);
  const students = p.fams.some((f) => f.members.length);
  return [
    { label: "Room chart", purpose: "For the wall or the door: who sits where, each round.", pages: p.rounds + (students ? 1 : 0), make: () => seatingChartHtml(p, s.title, null, true, "", loc) },
    { label: "Alumni cards", purpose: "One for each alum: where to go each round.", pages: Math.ceil(p.hosts.length / 2), make: () => hostCardsHtml(p, null, s.title, "", loc) },
    { label: "Table numbers", purpose: "Fold one and stand it on each table.", pages: p.fams.length, make: () => tableTentsHtml(p) },
    { label: "Run sheet", purpose: "For you and the MC: the order of the night and a check-in list.", pages: 1 + Math.ceil((p.hosts.length + p.fams.length) / 26), make: () => runSheetHtml(p, s.title, s.startTime, s.roundMinutes) },
  ];
}

function thumb(html: string, label: string): HTMLElement {
  const frame = h("iframe", { className: "c-thumb-frame", title: `Preview of the ${label}`, tabindex: -1, "aria-hidden": "true", sandbox: "", loading: "lazy" }) as HTMLIFrameElement;
  frame.srcdoc = html.replace(/<body/, '<body style="margin:24px;overflow:hidden"');
  const box = h("div", { className: "c-thumb", "aria-hidden": "true" }, frame);
  // Scale the letter-size page to whatever width the card has.
  new ResizeObserver(([e]) => { frame.style.transform = `scale(${e.contentRect.width / 816})`; }).observe(box);
  return box;
}

function printPage(): HTMLElement {
  const s = ev();
  const p = s.plan!;
  const list = docs(s, p);
  const total = list.reduce((n, d) => n + d.pages, 0); // an estimate: long names can add a page
  const reprint = reprintNeeded(s);
  const loc = famLocations(s);
  const recorded = () => { ctx.markPrinted(); say("ok", "You are ready for the event. If anything changes, the app will tell you exactly what to reprint."); };
  const doors = h("input", { id: "c-doors", type: "text", value: s.startTime, placeholder: "e.g. 6:30 PM" }) as HTMLInputElement;
  doors.addEventListener("input", () => { s.startTime = doors.value; ctx.persist(); });
  const minutes = h("select", { id: "c-minutes" }, [10, 15, 20, 25, 30, 40].map((n) => h("option", { value: n, selected: n === s.roundMinutes }, `${n} minutes`))) as HTMLSelectElement;
  minutes.addEventListener("change", () => { s.roundMinutes = Number(minutes.value); ctx.persist(); });
  const name = h("input", { id: "c-print-name", type: "text", value: s.title }) as HTMLInputElement;
  name.addEventListener("input", () => { s.title = name.value; ctx.persist(); });
  const extra: [string, string, () => string][] = [
    ["Runner sheets", "for two volunteers who walk alumni to tables", () => runnerSheetsHtml(p, s.title, 2, loc)],
    ["Volunteer role cards", "door, runner, MC, floater", () => roleCardsHtml(s.title)],
    ["Backup packet", "the whole night on paper", () => backupPacketHtml(p, s.title, s.printedAt)],
    ["Alumni badges", "each alum's tables, for a name badge", () => hostBadgesHtml(p, s.title, loc)],
    ["Summary for a director", "the plan on one page", () => planSummaryHtml(p, s.title, [], s.notes)],
  ];
  const printedOk = !!s.printed && !reprint.length && isCurrent(s);
  return h("section", { className: "c-page" },
    h("h1", { tabindex: -1 }, "Print"),
    printedOk ? h("div", { className: "c-answer" }, h("span", { className: "c-answer-mark", "aria-hidden": "true" }, "✓"),
      h("div", {}, h("p", { className: "c-answer-main" }, "You are ready for the event."), h("p", { className: "c-help" }, `Printed${s.printedAt ? ` at ${s.printedAt}` : ""}. If anything changes, the app tells you exactly what to reprint.`))) : null,
    !isCurrent(s) ? h("div", { className: "c-msg warn" }, "Your lists changed since the schedule was made. Update the schedule first. ",
      h("button", { className: "c-link", onclick: () => go("schedule") }, "Go to Schedule")) : null,
    reprint.length ? h("div", { className: "c-msg warn" }, h("strong", {}, "Your schedule changed after you printed. Reprint only these:"),
      h("ul", {}, reprint.map((r) => h("li", {}, plain(r).replace(/host card/g, "alumni card").replace(/table tent/g, "table number").replace(/seating chart/g, "room chart")))),
      h("button", { className: "c-button primary", onclick: () => {
        const out = reprintList(s.printed!, p);
        const stamp = ctx.now();
        const parts: [string, string][] = [];
        if (out.seatingChart) parts.push(["Room chart pages", seatingChartHtml(p, s.title, out.seatingRounds, out.finderPage, stamp, loc)]);
        if (out.hostIds.length) parts.push(["Alumni cards", hostCardsHtml(p, out.hostIds, s.title, stamp, loc)]);
        if (out.famIds.length) parts.push(["Table numbers", tableTentsHtml(p, out.famIds, stamp)]);
        openPage(printEverythingHtml(`${s.title}: updated pages`, parts));
        recorded();
        render();
      } }, "Print only the changed pages")) : null,
    h("ul", { className: "c-docs" }, list.map((d) => h("li", {}, thumb(d.make(), d.label),
      h("div", { className: "c-doc-text" }, h("strong", {}, d.label), h("span", { className: "c-help" }, d.purpose), h("span", { className: "c-pages" }, `About ${d.pages} page${d.pages !== 1 ? "s" : ""}`))))),
    h("div", { className: "c-actions" },
      h("span", { className: "c-help" }, `About ${total} pages in all, on US Letter.`),
      h("button", { className: `c-button ${printedOk ? "" : "primary"} big`, disabled: !isCurrent(s), onclick: () => {
        if (!s.title.trim()) s.title = "Alumni dinner";
        openPage(printEverythingHtml(s.title, list.map((d) => [d.label, d.make()])));
        recorded();
        render();
      } }, printedOk ? "Print everything again" : "Print everything")),
    more(morePrint, () => { morePrint = !morePrint; render(); }, "More options",
      h("div", { className: "c-fields" },
        h("div", { className: "c-field" }, h("label", { for: "c-print-name", className: "c-label" }, "Name on every page"), name),
        h("div", { className: "c-field" }, h("label", { for: "c-doors", className: "c-label" }, "Doors open (adds times to the run sheet)"), doors),
        h("div", { className: "c-field" }, h("label", { for: "c-minutes", className: "c-label" }, "Each round lasts"), minutes)),
      h("p", { className: "c-label" }, "Print one at a time"),
      h("ul", { className: "c-plain-list" }, [...list.map((d): [string, string, () => string] => [d.label, d.purpose.charAt(0).toLowerCase() + d.purpose.slice(1), d.make]), ...extra].map(([label, purpose, make]) =>
        h("li", {}, h("button", { className: "c-link", onclick: () => openPage(make()) }, label), h("span", { className: "c-help" }, `: ${purpose.replace(/\.$/, "")}`))))),
    h("div", { className: "c-actions" }, h("span"), h("button", { className: "c-button big", onclick: () => go("run") }, "Next: run the event")));
}

// ----------------------------------------------------------------------
// Run: a separate mode for the night.
// ----------------------------------------------------------------------

async function applyChange(apply: () => string): Promise<void> {
  const s = ev();
  runProblem = apply();
  if (runProblem) { render(); return; }
  if (!s.printed) beforeChange = s.plan;
  change = null;
  changeOpen = false;
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
    announce(n ? `Done. ${n === 1 ? "One person needs" : `${n} people need`} telling; everyone else stays put.` : "Done. Nobody else moves.");
    runNote = n ? "" : "Done. Nobody else moves, and nothing needs reprinting.";
  }
  ctx.persist();
  render();
  (document.querySelector(".c-tell h2, .c-msg.error, .c-msg.ok") as HTMLElement | null)?.setAttribute("tabindex", "-1");
  (document.querySelector(".c-tell h2, .c-msg.error, .c-msg.ok") as HTMLElement | null)?.focus();
}

function runPage(): HTMLElement {
  const s = ev();
  const p = s.plan!;
  const current = isCurrent(s);
  const over = eventOver(s);
  return h("section", { className: "c-run" },
    h("header", { className: "c-run-top" },
      h("button", { className: "c-link", onclick: () => go("schedule") }, "‹ Planning"),
      h("strong", {}, s.title || "Your dinner"),
      ctx.inPractice() ? h("span", { className: "c-pill practice" }, "Practice ", h("button", { className: "c-link", onclick: () => ctx.endPractice() }, "End practice")) : h("span"),
      runMenuEl()),
    h("h1", { className: "visually-hidden", tabindex: -1 }, "Run the event"),
    busy ? h("div", { className: "c-card c-now" }, h("p", { className: "c-round" }, h("span", { className: "spinner" }), " Working out who moves…")) : roundCard(p),
    runProblem ? h("div", { className: "c-msg error", role: "alert" }, runProblem) : null,
    runNote ? h("div", { className: "c-msg ok" }, runNote) : null,
    current || busy ? null : h("div", { className: "c-msg warn c-row spread" }, "The schedule is out of date.",
      h("button", { className: "c-button primary", onclick: () => applyChange(() => "") }, "Update it")),
    current && !busy && !over ? tellList(p) : null,
    over || busy ? null : changeSheet(p),
    over ? h("div", { className: "c-card" }, h("p", {}, "That's a wrap. Thank your alumni and your fams."),
      h("button", { className: "c-button primary big wide", onclick: () => go("wrap") }, "Wrap up")) : null,
    busy ? null : whereList(p),
    ctx.inPractice() || s.finished > 0 || s.night.roundTimes?.["1"] ? null
      : h("p", { className: "c-help center" }, "Nervous? ", h("button", { className: "c-link", onclick: () => { practiceReturn = "run"; ctx.practice(); } }, "Practice a cancellation first"), ". Nothing is kept."));
}

function runMenuEl(): HTMLElement {
  return h("div", { className: "c-run-menu" },
    h("button", { className: "c-icon-button", "aria-label": "Night menu", "aria-expanded": runMenu ? "true" : "false", onclick: () => { runMenu = !runMenu; render(); if (runMenu) (document.querySelector(".c-run-menu .c-menu button") as HTMLElement | null)?.focus(); } }, "⋯"),
    runMenu ? h("div", { className: "c-menu" },
      h("button", { onclick: () => { runMenu = false; ctx.openNight(); } }, "Extra night tools: check-in, room setup, QR code for volunteers"),
      h("button", { onclick: () => { runMenu = false; go("print"); } }, "Print or reprint pages"),
      h("button", { onclick: () => { runMenu = false; go("wrap"); } }, "Wrap up")) : null);
}

function roundCard(p: EventPlan): HTMLElement {
  const s = ev();
  const st = status(s, nowMinutes());
  const r = st.round;
  const start = () => { startRound(s, r, nowMinutes()); logChange(s, ctx.now(), `Round ${r} started.`); runNote = ""; ctx.persist(); render(); };
  let action: HTMLElement | null;
  if (st.phase === "before" || st.phase === "moving") action = h("button", { className: "c-button primary big wide", "data-k": "round-action", onclick: start }, `Start round ${r}`);
  else if (st.phase === "during") {
    action = h("button", { className: "c-button primary big wide", "data-k": "round-action", onclick: () => {
      endRound(s, r, nowMinutes());
      showNext = false;
      runNote = "";
      if (r < p.rounds) { finishRound(s, ctx.now()); justFinished = s.finished; } else logChange(s, ctx.now(), `Round ${r} finished. The event is over.`);
      ctx.persist();
      render();
    } }, r < p.rounds ? `End round ${r}` : "End the last round");
  } else action = null;
  const startedAt = toMinutes(s.night.roundTimes?.[String(r)]?.start ?? "");
  return h("div", { className: "c-card c-now" },
    h("p", { className: "c-round" }, st.phase === "over" ? "All rounds done" : st.phase === "moving" ? `Alumni move to round ${r}` : `Round ${r} of ${p.rounds}`),
    st.phase === "during" && st.minutesLeft !== null ? h("p", { className: `c-clock ${st.minutesLeft < 0 ? "over" : ""}` },
      h("span", { id: "c-clock" }, leftText(st.minutesLeft)), startedAt !== null ? h("span", { className: "c-help" }, ` · ends ${shown(startedAt + s.roundMinutes)}`) : null)
      : st.phase === "before" ? h("p", { className: "c-help" }, `${p.rounds} rounds of ${s.roundMinutes} minutes.`) : null,
    action,
    justFinished === s.finished && st.phase === "moving" && s.finished > Math.max(0, ...p.lockedRounds) ? h("p", { className: "c-help" }, `Round ${s.finished} ended. `,
      h("button", { className: "c-link", onclick: () => {
        s.finished -= 1; justFinished = null;
        const k = String(s.finished + 1);
        const rt = s.night.roundTimes ?? {};
        if (rt[k]) s.night = { ...s.night, roundTimes: { ...rt, [k]: { start: rt[k].start } } };
        logChange(s, ctx.now(), `Round ${s.finished + 1} un-finished.`);
        ctx.persist();
        render();
      } }, "Undo")) : null);
}

function tellList(p: EventPlan): HTMLElement | null {
  const s = ev();
  const base = s.printed ?? beforeChange;
  if (!base) return null;
  const m = movesBetween(base, p, s.finished + 1);
  const told = new Set(s.night.told ?? []);
  const keyOf = (x: { round: number; hostId: string; now: string }) => `${x.round}|${x.hostId}|${x.now}`;
  const item = (key: string, text: string) => {
    const box = h("input", { type: "checkbox", checked: told.has(key), "data-k": `told-${key}` }) as HTMLInputElement;
    box.addEventListener("change", () => { toggleTold(s, key); ctx.persist(); render(); });
    return h("li", { className: told.has(key) ? "told" : "" }, h("label", { className: "c-checkline" }, box, h("span", {}, text)));
  };
  // Someone already told to move, whose move a later change undid, must be told again.
  const tables = tableNumbers(p);
  const live = new Set(m.hosts.map(keyOf));
  const redo: [string, string][] = [];
  for (const k of told) {
    if (k.startsWith("fam|")) {
      const [, round, famId] = k.split("|");
      const r = Number(round);
      if (r <= s.finished || m.fams.some((x) => x.round === r && x.famId === famId)) continue;
      const a = p.assignments.find((x) => x.round === r && x.groupId === famId);
      const fam = p.fams.find((f) => f.groupId === famId);
      if (!a || !fam) continue;
      const host = p.hosts.find((x) => x.hostId === a.hostId)!;
      redo.push([`redo|${k}|${a.hostId}`, `Table ${tables[famId]} (${fam.name}): change of plan for round ${r}. ${host.person || host.name} is coming after all.`]);
      continue;
    }
    const [round, hostId, was] = k.split("|");
    const r = Number(round);
    if (k.startsWith("fam|") || k.startsWith("redo|") || live.has(k) || r <= s.finished || !p.hosts.some((x) => x.hostId === hostId)) continue;
    if (m.hosts.some((x) => x.round === r && x.hostId === hostId)) continue; // the new instruction already covers it
    const now = p.assignments.find((a) => a.round === r && a.hostId === hostId)?.groupId;
    if (now === was) continue;
    const host = p.hosts.find((x) => x.hostId === hostId)!;
    const fam = p.fams.find((f) => f.groupId === now);
    redo.push([`redo|${k}|${now ?? ""}`, `${host.person || host.name}: change of plan for round ${r}. ` + (fam ? `Go to Table ${tables[fam.groupId]} (${fam.name}), not the table you were told earlier.` : "No table in that round after all; wait near the front.")]);
  }
  const keys = [...m.hosts.map(keyOf), ...m.fams.map((x) => `fam|${x.round}|${x.famId}`), ...redo.map(([k]) => k)];
  const left = keys.filter((k) => !told.has(k)).length;
  if (!m.hosts.length && !m.fams.length && !redo.length) return null;
  const cardWord = (t: string) => (s.printed ? t : t.replace(/your card said/gi, "before, you had").replace(/as your card says/gi, "as planned"));
  return h("section", { className: "c-card c-tell" },
    h("h2", {}, left ? `Tell these people to move (${left} left)` : "Everyone has been told"),
    h("p", { className: "c-help" }, "Everyone else stays where their card says."),
    h("ul", {}, redo.map(([k, t]) => item(k, t)), m.hosts.map((x) => item(keyOf(x), cardWord(x.text))), m.fams.map((x) => item(`fam|${x.round}|${x.famId}`, cardWord(x.text)))),
    m.hosts.length ? h("button", { className: "c-link", onclick: () => openPage(changeSlipsHtml(p, m.hosts, s.title, ctx.now())) }, "Print a slip for each person") : null);
}

function changeSheet(p: EventPlan): HTMLElement {
  const s = ev();
  const cur = currentRound(s);
  const underWay = !!s.night.roundTimes?.[String(cur)]?.start && !s.night.roundTimes?.[String(cur)]?.end;
  const firstOpen = Math.min(p.rounds, underWay ? cur + 1 : cur);
  const openRounds = Array.from({ length: p.rounds - s.finished }, (_, i) => s.finished + 1 + i);
  const roundPick = (label: string, chosen: number) => h("select", { "aria-label": label },
    openRounds.map((r) => h("option", { value: r, selected: r === chosen }, `from round ${r}`))) as HTMLSelectElement;
  if (!changeOpen) {
    return h("div", { className: "c-change-entry" },
      h("button", { className: "c-button big wide outline", "data-k": "someone-changed", onclick: () => { changeOpen = true; change = null; runProblem = ""; runNote = ""; render(); (document.querySelector(".c-change h2") as HTMLElement | null)?.focus(); } }, "Someone changed?"));
  }
  const choices: [NonNullable<typeof change>, string][] = [
    ["left", "An alum left or didn't come"], ["arrived", "An alum arrived late, or someone new came"],
    ["table", "A fam is sitting at a different table"], ["wrong", "An alum is at the wrong table"], ["famLeft", "A whole fam left"],
  ];
  let form: HTMLElement | null = null;
  const run = (label: string, f: () => string) => h("button", { className: "c-button primary big wide", onclick: () => applyChange(f) }, label);
  if (change === "left") {
    const here = s.hosts.filter((r) => named(r) && !(r.host_id in s.cancelHosts));
    const who = h("select", { "aria-label": "Alum who left" }, h("option", { value: "" }, "Who?"), here.map((r) => h("option", { value: r.host_id }, r.host_name || r.table_label))) as HTMLSelectElement;
    const from = roundPick("Misses from round", firstOpen);
    form = h("div", { className: "c-form" }, who, from, run("Work out who moves", () => {
      if (!who.value) return "Choose who left.";
      cancelHost(s, who.value, Number(from.value), ctx.now(), Number(from.value) === 1 && !underWay);
      return "";
    }));
  } else if (change === "arrived") {
    const away = s.hosts.filter((r) => named(r) && r.host_id in s.cancelHosts);
    const who = h("select", { "aria-label": "Alum who arrived" }, h("option", { value: "" }, "Who?"),
      away.map((r) => h("option", { value: r.host_id }, r.host_name || r.table_label)), h("option", { value: "new" }, "Someone not on the list")) as HTMLSelectElement;
    const name = h("input", { type: "text", placeholder: "Their name", "aria-label": "New alum's name" }) as HTMLInputElement;
    const tags = h("input", { type: "text", placeholder: "What they can talk about", "aria-label": "New alum's interests" }) as HTMLInputElement;
    const from = roundPick("Hosts from round", firstOpen);
    const extra = h("div", { className: "c-form" }, name, tags);
    if (!away.length) who.value = "new";
    extra.hidden = who.value !== "new";
    who.addEventListener("change", () => { extra.hidden = who.value !== "new"; });
    form = h("div", { className: "c-form" }, who, extra, from, run("Work out who moves", () => {
      if (!who.value) return "Choose who arrived.";
      if (who.value === "new") return addLateHost(s, { table: name.value, person: name.value, tags: tags.value, from: Number(from.value) }, ctx.now()).replace(/host table/g, "alum");
      return joinLate(s, who.value, Number(from.value), ctx.now());
    }));
  } else if (change === "table") {
    const fam = h("select", { "aria-label": "Fam at another table" }, h("option", { value: "" }, "Which fam?"), famsOf(s).map((r) => h("option", { value: r.fam_id }, r.fam_label))) as HTMLSelectElement;
    const table = h("input", { type: "number", min: 1, step: 1, inputmode: "numeric", placeholder: "Table number they are at", "aria-label": "Table they are at" }) as HTMLInputElement;
    form = h("div", { className: "c-form" }, fam, table, h("p", { className: "c-help" }, "Don't move the students: the alumni come to them. If another fam has that table number, the two fams swap numbers."),
      run("Work out who moves", () => (fam.value ? moveFamTable(s, fam.value, Number(table.value), ctx.now()) : "Choose the fam.")));
  } else if (change === "wrong") {
    const tables = tableNumbers(p);
    const fam = h("select", { "aria-label": "Table" }, h("option", { value: "" }, "Which table?"),
      [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]).map((f) => h("option", { value: f.groupId }, `Table ${tables[f.groupId]}, ${f.name}`))) as HTMLSelectElement;
    const who = h("select", { "aria-label": "Who is actually there" }, h("option", { value: "" }, "Who is actually there?"),
      p.hosts.filter((x) => !(p.hostAway[x.hostId] ?? []).includes(cur)).map((x) => h("option", { value: x.hostId }, x.person || x.name))) as HTMLSelectElement;
    form = h("div", { className: "c-form" }, fam, who, h("p", { className: "c-help" }, `They stay there for round ${cur}; the rest of the night is worked out around it.`),
      run("Keep it this way", () => (fam.value && who.value ? recordActual(s, fam.value, who.value, cur, ctx.now()) : "Choose the table and who is there.")));
  } else if (change === "famLeft") {
    const fam = h("select", { "aria-label": "Fam that left" }, h("option", { value: "" }, "Which fam?"),
      famsOf(s).filter((r) => !(r.fam_id in s.cancelFams)).map((r) => h("option", { value: r.fam_id }, r.fam_label))) as HTMLSelectElement;
    const from = roundPick("Fam misses from round", firstOpen);
    form = h("div", { className: "c-form" }, fam, from, run("Work out who moves", () => {
      if (!fam.value) return "Choose the fam.";
      cancelFam(s, fam.value, Number(from.value), ctx.now());
      return "";
    }));
  }
  return h("section", { className: "c-card c-change" },
    h("div", { className: "c-row spread" }, h("h2", { tabindex: -1 }, change ? choices.find(([k]) => k === change)![1] : "What happened?"),
      h("button", { className: "c-link", onclick: () => { changeOpen = false; change = null; runProblem = ""; render(); } }, "Close")),
    change ? h("button", { className: "c-link", onclick: () => { change = null; runProblem = ""; render(); } }, "‹ Something else happened") : null,
    runProblem && change ? h("div", { className: "c-msg error", role: "alert" }, runProblem) : null,
    change ? form : h("div", { className: "c-options", role: "group", "aria-label": "What happened?" }, choices.map(([key, label]) =>
      h("button", { className: "c-option", "data-k": `change-${key}`, onclick: () => { change = key; runProblem = ""; render(); (document.querySelector(".c-change select, .c-change input") as HTMLElement | null)?.focus(); } }, h("span", {}, label), h("span", { "aria-hidden": "true" }, "›")))),
    h("p", { className: "c-help" }, "Finished rounds never change."));
}

function whereList(p: EventPlan): HTMLElement {
  const s = ev();
  const cur = currentRound(s);
  const last = cur >= p.rounds;
  const r = showNext && !last ? cur + 1 : cur;
  const tables = tableNumbers(p);
  const found = () => whereIs(p, whereQuery, cur).map((f) => h("div", { className: "c-found" }, h("strong", {}, f.title), h("span", { className: "c-help" }, " ", f.lines.join("; "))));
  const search = p.fams.length > 12 ? (() => {
    const box = h("input", { id: "c-find", type: "search", value: whereQuery, placeholder: "Find an alum, fam, or student", "aria-label": "Find someone" }) as HTMLInputElement;
    const out = h("div", { "aria-live": "polite" }, found());
    box.addEventListener("input", () => { whereQuery = box.value; replace(out, ...found()); });
    return h("div", { className: "c-form" }, box, out);
  })() : null;
  return h("section", { className: "c-where-wrap" },
    h("button", { className: "c-more-head", "aria-expanded": showWhere ? "true" : "false", "data-k": "where", onclick: () => { showWhere = !showWhere; render(); } },
      showWhere ? `Who is where, round ${r}` : "See who is at each table", h("span", { "aria-hidden": "true" }, showWhere ? " ▴" : " ▾")),
    showWhere ? h("div", { className: "c-card" },
      last ? null : h("div", { className: "c-row" },
        h("button", { className: `c-chip ${r === cur ? "on" : ""}`, "aria-pressed": r === cur ? "true" : "false", onclick: () => { showNext = false; render(); } }, `Round ${cur}`),
        h("button", { className: `c-chip ${r !== cur ? "on" : ""}`, "aria-pressed": r !== cur ? "true" : "false", onclick: () => { showNext = true; render(); } }, `Round ${cur + 1}`)),
      search,
      h("ul", { className: "c-where" }, [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]).map((f) => {
        const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
        const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
        const gone = (p.famAway[f.groupId] ?? []).includes(r);
        return h("li", { className: host ? "" : "empty" }, h("span", { className: "c-num" }, String(tables[f.groupId])), h("span", { className: "fam" }, f.name),
          h("span", { className: "who" }, gone ? "fam has left" : host ? hostLabel(host) : "no alum this round"));
      }))) : null);
}

// ----------------------------------------------------------------------
// Wrap up.
// ----------------------------------------------------------------------

function wrapPage(): HTMLElement {
  const s = ev();
  const notes = h("textarea", { id: "c-notes", rows: 5, placeholder: "What worked, what didn't, which table is loud…" }) as HTMLTextAreaElement;
  notes.value = s.notes;
  notes.addEventListener("input", () => { s.notes = notes.value; ctx.persist(); });
  const names = famsOf(s).some((r) => (r.students ?? "").trim());
  return h("section", { className: "c-page" },
    h("h1", { tabindex: -1 }, "Wrap up"),
    h("p", { className: "c-lead" }, "Two minutes now saves next year's coordinator an evening."),
    h("div", { className: "c-card" },
      h("label", { for: "c-notes", className: "c-label" }, "What would you change next year?"), notes,
      h("p", { className: "c-help" }, "No student names here, please.")),
    h("div", { className: "c-actions" }, h("span", { className: "c-help" }, "One file with your alumni, fams, and notes. No student names, no schedules."),
      h("button", { className: "c-button primary big", onclick: () => {
        ctx.handOff();
        say("ok", "Saved as a .zip file. Give it to next year's coordinator: they unzip it, choose Open last year's file, and pick the file ending in .rotation.json.");
        render();
      } }, "Save for next year")),
    names ? h("p", { className: "c-help" }, "Your office may ask you not to keep student names. ",
      h("button", { className: "c-link", onclick: () => {
        if (!sure) { sure = true; render(); return; }
        sure = false; ctx.removeStudentNames(); say("ok", "Student names deleted from this event."); render();
      } }, sure ? "Yes, delete them now" : "Delete student names from this event")) : null);
}

/** For tests and the app shell. */
export function guidedStep(n: number): void { go((["setup", "schedule", "print", "run", "wrap"] as Place[])[n] ?? "home"); }
export const guidedFieldsCount = () => FIELDS.length;
