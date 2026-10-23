// The coordinator's app: four places and an end state, in event words.
//
//   Set up  ·  Schedule  ·  Print  ·  Run      (then Wrap up)
//
// Set up is three cards that collapse when done. The schedule is made on
// arrival and reads as a room plan; changes happen in Adjust. Print says what
// to print and why. Run is its own full-screen mode for a phone in one hand:
// the round, the clock, one button, and "Something came up", which turns any
// change into a list of people to tell. Everything else waits behind "More
// options" or the event menu (⋯). The full planner, with every option,
// stays at the address ending in #full.

import { h, openPage, readFile, replace } from "./dom";
import { avatars, famHue, peopleIn } from "./faces";
import { IconName, icon } from "./icons";
import { TOUR_STEPS, openTour, tourSeen, tourStep } from "./tour";
import {
  saveEvent, EventState, FAM_COLUMNS, HOST_COLUMNS, applySpelling, checkInputs, famLocations, hasStarted, isCurrent, loadEvent,
  maxRounds, nearMisses, newEvent, normalizeState, normalizeTable, stepFreeFams,
} from "./event";
import { explainPairing } from "./explain";
import { hostCardsHtml, runSheetHtml, seatingChartHtml, tableNumbers, tableTentsHtml } from "./export";
import { FIELDS } from "./forms";
import { changeSlipsHtml, movesBetween } from "./moves";
import {
  addLateHost, cancelFam, cancelHost, currentRound, finishRound, joinLate, logChange, moveFamTable, recordActual, roomTables, toggleTold, whereIs,
} from "./night";
import { gridFromHtml, looksLikeHeader, parsePasted } from "./paste";
import { ListedAlum, SeatingChart, pairKey, readAlumniList, readSeatingChart } from "./seating";
import { qrSvg } from "./share";
import { STEW_FAMS, STEW_PEOPLE, STEW_TABLES, stewChartGrid, stewInterests } from "./stew2026";
import { careerWords, majorWords } from "./words";
import { HostSettings, clearGrid, gridChanges, hostSettings, placeInGrid, renameInRules, setHostSettings, settingsWords } from "./people";
import type { EventPlan } from "./planning";
import { describeReprint, hostLabel, provenOptimal, reprintList } from "./planning";
import {
  backupPacketHtml, coordinatorGuideHtml, hostBadgesHtml, planSummaryHtml, printEverythingHtml, privacyNoteHtml, roleCardsHtml, runnerSheetsHtml,
} from "./printables";
import { csvRecords } from "./py";
import { CleanRow, dropExampleRows, groupStudentRows, matchColumns, renameColumns } from "./sheets";
import { endRound, hhmm, nowMinutes, shown, startRound, status, toMinutes } from "./timing";

/** What the coordinator's pages need from the app around them. */
export interface GuidedCtx {
  get(): EventState;
  set(s: EventState): void;
  persist(): void;
  now(): string;
  /** Plan or update the schedule; returns a problem in plain words, or "" when it worked. */
  solve(keepPrinted: boolean): Promise<string>;
  /** An event sent from another device, waiting for the coordinator to say yes. */
  incoming(): EventState | null;
  takeIncoming(accept: boolean): void;
  /** A link that opens this event on another device, without student names. */
  phoneLink(): Promise<string>;
  /** Plan an event that is not the open one, for the walkthrough. */
  solveOn(s: EventState, keepPrinted: boolean): Promise<string>;
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
let paired: string[] = []; // pairs made from alumni who share a field, said once after an import
let fromChart = false; // the lists came from a seating chart, whose seating is kept
let pairA = "";
let showMatches = false;
let cardNote: { card: "dinner" | "hosts" | "fams"; text: string; preview: string } | null = null; // what a paste did, shown in its card
let focusAfter: string | null = null; // a data-k to focus after the next render
let format: "chart" | "list" | "lines" = "chart"; // which example sits beside the paste boxes
let confirmNew = false; // "Start another dinner" asked, waiting for a yes
let leaveRun = false; // "Back to planning" tapped during a round
let swapSaved = false;
let opened: { plan: EventPlan | null; docs: Set<string> } = { plan: null, docs: new Set() }; // printouts opened one at a time, for this schedule
let phone: { link: string; copied: boolean } | null = null;
let undoSnap: { label: string; json: string } | null = null;
let undoTimer = 0;
// Schedule
let adjust = false;
let picked: { round: number; famId: string } | null = null;
let showRound = 1; // the room shows one round at a time; 0 shows the whole night as a grid
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
const whoAt = (r: CleanRow) => (r.host_name || r.table_label || "").trim();
/** Everyone at the alumni tables, counting both people in a pair. */
const peopleCount = (s: EventState) => hostsOf(s).reduce((n, r) => n + Math.max(1, peopleIn(whoAt(r)).length), 0);
const pairCount = (s: EventState) => hostsOf(s).filter((r) => peopleIn(whoAt(r)).length > 1).length;

const famsN = (n: number) => `${n} fam${n !== 1 ? "s" : ""}`;

function remember(): void {
  try { localStorage.setItem(STEP_KEY, place); } catch { /* only a convenience */ }
}

function go(next: Place): void {
  if (adjust && picked) say("info", "You left in the middle of a swap, so nothing moved.");
  place = next;
  confirmNew = false; leaveRun = false; cardNote = null; swapSaved = false; phone = null;
  undoSnap = null; clearTimeout(undoTimer); // an Undo only makes sense on the screen where the change was made
  changed = []; problems = []; picked = null; why = false; adjust = false; menu = false; runMenu = false;
  change = null; changeOpen = false; runProblem = ""; runNote = ""; editing = null; adding = null; noteFor = null; imported = null; paired = []; showMatches = false;
  remember();
  render(true);
  window.scrollTo(0, 0);
}

function say(kind: "ok" | "info" | "warn" | "error", text: string): void {
  message = [kind, text];
}

/** Make a change that can be taken back for ten seconds: "Removed Bo Lin. Undo". */
function undoable(label: string, change: () => void): void {
  const before = saveEvent(ev());
  const noteBefore = cardNote;
  change();
  if (cardNote === noteBefore) cardNote = null; // an older note no longer describes the last change
  undoSnap = { label, json: before };
  // Shown now, even when the change already redrew the page; the next redraw keeps it.
  document.querySelector(".c-toast")?.remove();
  const t = toast();
  if (t) document.getElementById("main")?.append(t);
  clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => { undoSnap = null; document.querySelector(".c-toast")?.remove(); }, 10000);
}

function undoLast(): void {
  if (!undoSnap) return;
  ctx.set(loadEvent(undoSnap.json));
  announce(`Undone: ${undoSnap.label}`);
  undoSnap = null;
  cardNote = null;
  clearTimeout(undoTimer);
  render();
}

function toast(): HTMLElement | null {
  if (!undoSnap || (cardNote && place === "setup")) return null; // the card's own note offers Undo
  return h("div", { className: "c-toast", role: "status" }, h("span", {}, undoSnap.label),
    h("button", { className: "c-link", "data-k": "undo", onclick: undoLast }, "Undo"));
}

/** A small file for the coordinator to keep, made in the page. */
function download(name: string, text: string, type = "text/csv"): void {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
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

/** Why a step is not ready, or what needs a look: shown on the tab and on the home page. */
function reasonFor(t: Place): string {
  const s = ev();
  const st = stateOf(t);
  if (st === "locked") return t === "schedule" ? "Add your alumni and fams first" : "Make the schedule first";
  if (st !== "attention") return "";
  if (t === "schedule") {
    if (!isCurrent(s)) return "Your lists changed: update the schedule";
    const n = s.plan ? emptyFams(s.plan).length : 0;
    return `${famsN(n)} ${n === 1 ? "has" : "have"} no alum`;
  }
  if (t === "print") return !isCurrent(s) ? "Update the schedule, then reprint" : `Reprint ${reprintNeeded(s).length} page${reprintNeeded(s).length !== 1 ? "s" : ""}`;
  return "";
}

const TAB_ICONS: Record<string, IconName> = { setup: "people", schedule: "table", print: "printer", run: "play" };
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
      place === "home" ? h("span", { className: "c-home-link" }, logo(), h("strong", { className: "c-title" }, "Rotation Dinner"))
        : h("button", { className: "c-home-link", "aria-label": `Home: ${s.title || "Your dinner"}`, "data-k": "home-link", onclick: () => go("home") },
          logo(), h("strong", { className: "c-title" }, s.title || "Your dinner")),
      practising ? h("span", { className: "c-pill practice" }, "Practice ", h("button", { className: "c-link", onclick: () => ctx.endPractice() }, "End practice"))
        : place !== "home" ? h("span", { className: "c-saved" }, "Saved on this computer \u00b7 ",
          h("button", { className: "c-link small", onclick: () => { ctx.saveFile(); say("ok", "A copy of your event was downloaded. Keep it with your event files, or open it on another computer."); render(); } }, "Download a copy")) : null,
      eventMenu()),
    place !== "home" ? h("nav", { className: "c-tabs", "aria-label": "Event" }, TABS.map(([key, label]) => {
      const st = stateOf(key);
      const why = reasonFor(key);
      return h("button", {
        className: `c-tab ${place === key ? "now" : ""} ${st}`, title: why || null,
        "aria-current": place === key ? "page" : null, "aria-label": `${label}, ${STATE_WORDS[st]}${why ? `: ${why}` : ""}`,
        onclick: () => go(key),
      }, h("span", { className: "c-tab-icon" }, icon(TAB_ICONS[key]), st === "done" ? h("span", { className: "c-mark", "aria-hidden": "true" }, icon("check")) : null),
        h("span", { className: "c-tab-label" }, label), st === "attention" ? h("span", { className: "c-dot", "aria-hidden": "true" }) : null);
    }), eventOver(s) ? h("button", { className: `c-tab ${place === "wrap" ? "now" : ""}`, "aria-current": place === "wrap" ? "page" : null, onclick: () => go("wrap") },
      h("span", { className: "c-tab-icon" }, icon("check")), h("span", { className: "c-tab-label" }, "Wrap up")) : null) : null);
}

function eventMenu(): HTMLElement {
  const s = ev();
  const group = (name: string, ...items: (HTMLElement | null)[]) => h("div", { className: "c-menu-group", role: "group", "aria-label": name }, h("p", { className: "c-menu-name" }, name), ...items);
  return h("div", { className: "c-menu-wrap" },
    h("button", { className: "c-icon-button", "aria-label": "Event menu", "aria-expanded": menu ? "true" : "false", onclick: () => { menu = !menu; render(); if (menu) (document.querySelector(".c-menu button, .c-menu label") as HTMLElement | null)?.focus(); } }, "\u22ef"),
    menu ? h("div", { className: "c-menu" },
      group("Your event",
        h("button", { onclick: () => { menu = false; go("home"); } }, "Home"),
        place !== "home" || hasPeople(s) ? h("button", { onclick: () => { menu = false; ctx.saveFile(); say("ok", "A copy of your event was downloaded. Keep it with your event files, or open it on another computer."); render(); } }, "Download a copy") : null,
        h("label", { for: "c-open", className: "c-menu-label", tabindex: 0 }, openInput("c-open"), "Open a saved event"),
        hasPeople(s) && !ctx.inPractice() ? h("button", { onclick: () => { menu = false; go("home"); confirmNew = true; render(); } }, "Start another dinner") : null,
        s.plan ? h("button", { onclick: () => { menu = false; startPhone(); } }, "Send to your phone") : null,
        s.plan ? h("button", { onclick: () => go("wrap") }, "Wrap up and save for next year") : null),
      group("Help",
        h("button", { onclick: startTour }, "Take the 2-minute tour"),
        h("button", { onclick: () => { menu = false; openPage(coordinatorGuideHtml(s.title)); } }, "Print a one-page guide")),
      group("More",
        s.plan ? h("button", { onclick: () => { menu = false; ctx.openNight(); } }, "Extra night tools: check-in, room setup, QR code") : null,
        h("button", { onclick: () => { menu = false; ctx.offlineCopy(); } }, "Download the app for use without internet"),
        h("button", { onclick: () => { menu = false; openPage(privacyNoteHtml()); } }, "Privacy note for IT"))) : null);
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
  // Opening the app starts on the event's home page, which says what is next.
  // Only the night itself comes straight back: a round under way, or the wrap-up after it.
  if (place === "home" && hasPeople(ev()) && ev().plan) {
    try {
      const saved = localStorage.getItem(STEP_KEY) as Place | null;
      if (saved === "run" && ev().night.roundTimes?.["1"]?.start) place = "run";
      if (saved === "wrap" && eventOver(ev())) place = "wrap";
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
    : place === "print" ? (s.plan ? printPage() : emptyPage("print")) : place === "run" ? (s.plan ? runPage() : emptyPage("run"))
    : place === "wrap" ? wrapPage() : setupPage();
  replace(app, h("main", { className: `coord ${running ? "running stage" : ""} ${place !== "home" && !running ? "with-bar" : ""}`, id: "main" },
    running ? null : topBar(), running ? null : msg(), body, running ? null : nextBar(), toast()));
  const tab = TABS.find(([k]) => k === place)?.[1] ?? (place === "wrap" ? "Wrap up" : "");
  document.title = place === "home" ? "Rotation Dinner" : `${tab} · ${s.title || "Your dinner"}`;
  if (focusAfter) { (document.querySelector(`[data-k="${focusAfter}"]`) as HTMLElement | null)?.focus({ preventScroll: false }); focusAfter = null; }
  else if (newPlace) (document.querySelector("#main h1") as HTMLElement | null)?.focus({ preventScroll: true });
  else restoreFocus(key);
  if (running) clockTimer = window.setInterval(tick, 1000);
}

/**
 * Seconds left in round r. The event file keeps start times to the minute,
 * so the exact moment the round was started on this device is kept too, and
 * used while it agrees with the recorded start.
 */
function secondsLeft(s: EventState, r: number, minutesLeft: number): number {
  const ms = s.night.startedAt?.[String(r)];
  const start = s.night.roundTimes?.[String(r)]?.start;
  if (ms && start) {
    const d = new Date(ms);
    if (hhmm(d.getHours() * 60 + d.getMinutes()) === start) return Math.round(s.roundMinutes * 60 - (Date.now() - ms) / 1000);
  }
  return minutesLeft * 60;
}

/** "19:42" for the big clock; past the end it counts up. */
const mmss = (sec: number) => { const a = Math.abs(sec); return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`; };
const clockWords = (sec: number) => (sec < 0 ? "over" : "left");

/** Update only the clock on the Run screen, every second, so nothing else moves under the coordinator's thumb. */
function tick(): void {
  const el = document.getElementById("c-clock");
  if (!el) return;
  const s = ev();
  const st = status(s, nowMinutes());
  if (st.phase === "during" && st.minutesLeft !== null) {
    const sec = secondsLeft(s, st.round, st.minutesLeft);
    const num = document.getElementById("c-clock-num");
    if (num) num.textContent = mmss(sec);
    el.textContent = clockWords(sec);
    const ring = document.getElementById("c-ring");
    if (ring) ring.setAttribute("stroke-dashoffset", String(ringOffset(s.roundMinutes, sec)));
    document.querySelector(".c-timer")?.classList.toggle("over", sec < 0);
  }
}

const RING = 2 * Math.PI * 92;
const ringOffset = (roundMinutes: number, sec: number) => (RING * elapsedShare(roundMinutes, sec / 60)) / 100;

/** The round as a ring that empties as time passes, with the time left in the middle. */
function timer(roundMinutes: number, sec: number): HTMLElement {
  const wrap = h("div", { className: `c-timer ${sec < 0 ? "over" : ""}` });
  wrap.innerHTML = `<svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="92" class="c-ring-track"/><circle id="c-ring" cx="100" cy="100" r="92" class="c-ring-fill" stroke-dasharray="${RING}" stroke-dashoffset="${ringOffset(roundMinutes, sec)}" transform="rotate(-90 100 100)"/></svg>`;
  wrap.append(h("p", { className: "c-timer-text" }, h("span", { id: "c-clock-num", className: "c-timer-num" }, mmss(sec)), " ", h("span", { id: "c-clock" }, clockWords(sec))));
  return wrap;
}

/** How much of the round has gone, as a percentage for the progress bar. */
function elapsedShare(roundMinutes: number, minutesLeft: number): number {
  if (!roundMinutes) return 0;
  return Math.min(100, Math.max(0, (1 - minutesLeft / roundMinutes) * 100));
}

// ----------------------------------------------------------------------
// Home.
// ----------------------------------------------------------------------

// ----------------------------------------------------------------------
// The next-step bar: where you are, the way back, and the one thing to do next.
// ----------------------------------------------------------------------

const STEP_OF: Partial<Record<Place, [number, string]>> = { setup: [1, "Set up"], schedule: [2, "Schedule"], print: [3, "Print"], run: [4, "Run"], wrap: [5, "Wrap up"] };

function nextBar(): HTMLElement | null {
  const s = ev();
  const at = STEP_OF[place];
  if (!at) return null;
  const back: Record<string, [string, Place]> = { setup: ["Home", "home"], schedule: ["Set up", "setup"], print: ["Schedule", "schedule"], run: ["Print", "print"], wrap: ["Home", "home"] };
  const [backLabel, backTo] = back[place];
  let action: HTMLElement | null = null;
  let note = "";
  const primary = (label: string, onclick: () => void, glyph?: IconName, disabled = false) =>
    h("button", { className: "c-button primary big", "data-k": `bar-${place}`, disabled, onclick }, glyph ? icon(glyph) : null, label, glyph ? null : icon("chevron"));
  const lists = hostsOf(s).length > 0 && famsOf(s).length > 0;
  if (place === "setup") {
    note = !hostsOf(s).length ? "Add your alumni to continue." : !famsOf(s).length ? "Add your fams to continue." : "";
    action = primary(s.plan ? "Update the schedule" : "Make the schedule", makeSchedule, undefined, !lists || busy);
  } else if (place === "schedule") {
    if (!s.plan) action = lists ? primary("Make the schedule", () => update()) : primary("Go to Set up", () => go("setup"));
    else if (!isCurrent(s)) action = primary("Update the schedule", () => update(), undefined, busy);
    else action = primary("Looks good: print", () => go("print"), "printer");
  } else if (place === "print") {
    if (!s.plan) action = primary(lists ? "Make the schedule" : "Go to Set up", () => (lists ? (go("schedule"), update()) : go("setup")));
    else if (s.printed && isCurrent(s) && !reprintNeeded(s).length) action = primary("Next: run the event", () => go("run"));
    else { note = `About ${docs(s, s.plan).reduce((n, d) => n + d.pages, 0)} pages, US Letter.`; action = primary("Print everything", printEverything, "printer", !isCurrent(s)); }
  } else if (place === "run") {
    action = primary(lists ? "Make the schedule" : "Go to Set up", () => (lists ? (go("schedule"), update()) : go("setup")));
  } else if (place === "wrap") {
    action = primary("Save for next year", () => { ctx.handOff(); say("ok", "Saved as a .zip file. Give it to next year's coordinator: they unzip it, choose Open a saved event, and pick the file ending in .rotation.json."); render(); }, "folder");
  }
  return h("div", { className: "c-nextbar", role: "region", "aria-label": "Next step" },
    h("button", { className: "c-link", "data-k": "bar-back", onclick: () => go(backTo) }, `\u2039 ${backLabel}`),
    h("span", { className: "c-nextbar-where" }, at[0] <= 4 ? `Step ${at[0]} of 4 \u00b7 ${at[1]}` : at[1]),
    note ? h("span", { className: "c-nextbar-note" }, note) : h("span", { className: "c-nextbar-note" }),
    action);
}

/** What a step will hold, before there is anything to show, and the one way to get there. */
function emptyPage(what: "schedule" | "print" | "run"): HTMLElement {
  const lists = hostsOf(ev()).length > 0 && famsOf(ev()).length > 0;
  const pic = h("div", { className: "c-empty-pic", "aria-hidden": "true" });
  pic.innerHTML = what === "schedule"
    ? `<svg viewBox="0 0 300 90"><g fill="var(--surface)" stroke="var(--hairline-strong)" stroke-width="2"><circle cx="50" cy="45" r="28"/><circle cx="150" cy="45" r="28"/><circle cx="250" cy="45" r="28"/></g><g fill="var(--accent)" opacity=".35"><circle cx="72" cy="66" r="7"/><circle cx="172" cy="66" r="7"/><circle cx="272" cy="66" r="7"/></g></svg>`
    : what === "print"
      ? `<svg viewBox="0 0 300 90"><g fill="var(--surface)" stroke="var(--hairline-strong)" stroke-width="1.5">${[0, 1, 2, 3].map((i) => `<rect x="${20 + i * 70}" y="8" width="56" height="74" rx="4"/>`).join("")}</g><g fill="var(--hairline)">${[0, 1, 2, 3].map((i) => `<rect x="${28 + i * 70}" y="18" width="30" height="5" rx="2"/><rect x="${28 + i * 70}" y="30" width="40" height="4" rx="2"/><rect x="${28 + i * 70}" y="40" width="36" height="4" rx="2"/>`).join("")}</g></svg>`
      : `<svg viewBox="0 0 300 90"><circle cx="150" cy="45" r="36" fill="none" stroke="var(--hairline-strong)" stroke-width="6"/><text x="150" y="51" text-anchor="middle" font-size="18" font-weight="700" fill="var(--ink-soft)">20:00</text></svg>`;
  const words: Record<string, [string, string]> = {
    schedule: ["Your room plan will appear here", lists ? "Your lists are ready. Make the schedule and the room appears here, one round at a time." : "Add your alumni and fams in Set up first; it takes about 2 minutes. Then the app seats everyone here."],
    print: ["Your printouts will appear here", "A room chart, alumni cards, table numbers, and a run sheet, all made from your schedule."],
    run: ["On the night, run it from here", "Open this on your phone on the night. You'll see the round, the clock, and who to tell when something changes."],
  };
  return h("section", { className: "c-page c-empty" },
    h("h1", { tabindex: -1 }, what === "schedule" ? "Schedule" : what === "print" ? "Print" : "Run"),
    h("div", { className: "c-card c-empty-card" }, pic, h("h2", {}, words[what][0]), h("p", { className: "c-help" }, words[what][1]),
      what === "run" ? h("button", { className: "c-link", onclick: async () => { practiceReturn = "run"; ctx.tryExample(); go("run"); } }, "Practice a night with the STEW 2026 dinner") : null));
}

/** "Send to your phone": a link that opens this event on another device. */
async function startPhone(): Promise<void> {
  go("home");
  phone = { link: "", copied: false };
  render();
  phone = { link: await ctx.phoneLink(), copied: false };
  render();
}

function phonePanel(): HTMLElement | null {
  if (!phone) return null;
  const qr = h("div", { className: "c-qr", "aria-hidden": "true" });
  if (phone.link && phone.link.length < 2800) qr.innerHTML = qrSvg(phone.link);
  return h("div", { className: "c-card c-phone" },
    h("h2", {}, "Send this dinner to your phone"),
    !phone.link ? h("p", { className: "c-help" }, "Making the link\u2026") : h("div", {},
      qr.innerHTML ? [qr, h("p", { className: "c-help" }, "Point your phone's camera at the code.")] : h("p", { className: "c-help" }, "Copy the link and send it to yourself (text or email), then open it on your phone."),
      h("div", { className: "c-row" },
        h("button", { className: "c-button primary", onclick: async () => { try { await navigator.clipboard.writeText(phone!.link); phone!.copied = true; } catch { /* the link is still shown */ } render(); } }, phone.copied ? "Copied" : "Copy the link"),
        "share" in navigator ? h("button", { className: "c-button", onclick: () => { (navigator as Navigator).share({ title: ev().title, url: phone!.link }).catch(() => {}); } }, "Share\u2026") : null,
        h("button", { className: "c-link", onclick: () => { phone = null; render(); } }, "Close")),
      h("p", { className: "c-fine" }, "The link carries the whole event, without student names. Anyone with it can open a copy, so send it only to yourself.")));
}

const PICTURE = `<svg viewBox="0 0 520 150" role="img" aria-label="Students stay at their tables while alumni move to the next table each round">
<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--accent)"/></marker></defs>
<g fill="var(--surface)" stroke="var(--hairline-strong)" stroke-width="2"><circle cx="90" cy="80" r="40"/><circle cx="260" cy="80" r="40"/><circle cx="430" cy="80" r="40"/></g>
<g fill="var(--ink-soft)" font-size="15" font-weight="600" text-anchor="middle" font-family="inherit"><text x="90" y="86">1</text><text x="260" y="86">2</text><text x="430" y="86">3</text></g>
<g fill="var(--accent-wash)" stroke="var(--accent)" stroke-width="1.5">
<circle cx="62" cy="50" r="7"/><circle cx="118" cy="50" r="7"/><circle cx="62" cy="110" r="7"/><circle cx="232" cy="50" r="7"/><circle cx="288" cy="50" r="7"/><circle cx="288" cy="110" r="7"/>
<circle cx="402" cy="50" r="7"/><circle cx="458" cy="110" r="7"/><circle cx="402" cy="110" r="7"/></g>
<g fill="var(--accent)" class="c-hop"><circle cx="118" cy="110" r="10"/><circle cx="232" cy="110" r="10"/><circle cx="458" cy="50" r="10"/></g>
<g fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="6 5" marker-end="url(#ah)"><path d="M132 118 Q175 140 216 120"/><path d="M246 122 Q360 150 448 68"/></g></svg>`;

/** The two-minute walkthrough, on a copy of this event or on an example dinner. */
function startTour(): void {
  if (menu) { menu = false; render(); }
  openTour({
    mine: () => (hasPeople(ev()) && !ctx.inPractice() ? ev() : null),
    solveOn: (s, keep) => ctx.solveOn(s, keep),
    now: () => ctx.now(),
    finish: (next) => {
      if (next === "start" && !hasPeople(ev())) { ctx.set(newEvent({ title: "", rounds: 3 })); openCard = "dinner"; go("setup"); return; }
      render();
    },
  });
}

function tourChoice(mine: boolean, primary: boolean): HTMLElement {
  const at = tourStep();
  return h("button", { className: `c-choice ${primary ? "primary" : ""}`, "data-k": "tour", onclick: startTour }, icon("play", "c-choice-icon"),
    h("span", { className: "c-choice-text" }, h("strong", {}, at ? "Continue the tour" : mine ? "Walk through your event" : "Take the 2-minute tour"),
      h("span", {}, at ? `You stopped at step ${at} of ${TOUR_STEPS}.` : mine ? "Two minutes, with your own alumni and fams." : "See a whole dinner, from the lists to the last round.")),
    icon("chevron", "c-choice-go"));
}

/** "Saturday, November 14 · 22 days to go", or nothing without a date. */
function dateLine(date: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!m) return "";
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / 86400000);
  const when = day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return days > 1 ? `${when} · ${days} days to go` : days === 1 ? `${when} · tomorrow` : days === 0 ? `${when} · today` : when;
}

/** The one thing to do next, in the coordinator's words. */
function nextStep(s: EventState): [string, () => void] {
  if (stateOf("setup") !== "done") return ["Next: add your alumni and fams", () => go("setup")];
  if (!s.plan) return ["Next: make the schedule", async () => { go("schedule"); await update(); }];
  if (!isCurrent(s)) return ["Next: update the schedule", () => go("schedule")];
  if (!s.printed) return ["Next: print", () => go("print")];
  if (reprintNeeded(s).length) return ["Next: reprint the changed pages", () => go("print")];
  if (eventOver(s)) return ["Next: wrap up", () => go("wrap")];
  return [s.night.roundTimes?.["1"] ? "Back to the event" : "Next: run the event", () => go("run")];
}

const STEP_TIME: Record<string, string> = { setup: "about 2 min", schedule: "about 1 min", print: "about 5 min", run: "on the night", wrap: "after" };

function homePage(): HTMLElement {
  const s = ev();
  const going = hasPeople(s) && !ctx.inPractice();
  const choice = (title: string, help: string, onclick: () => void, primary = false, glyph: IconName = "chevron") =>
    h("button", { className: `c-choice ${primary ? "primary" : ""}`, onclick }, icon(glyph, "c-choice-icon"),
      h("span", { className: "c-choice-text" }, h("strong", {}, title), h("span", {}, help)), icon("chevron", "c-choice-go"));
  const open = keyOpens(h("label", { className: "c-choice", for: "c-open-home", tabindex: 0 }, openInput("c-open-home"), icon("folder", "c-choice-icon"),
    h("span", { className: "c-choice-text" }, h("strong", {}, "Open a saved event"), h("span", {}, "A file you saved from this app, like last year's.")), icon("chevron", "c-choice-go")));
  const example = choice("See the STEW 2026 dinner", "Our real STEW 2026 dinner, ready to explore. Nothing you do is kept.", async () => { practiceReturn = "home"; ctx.tryExample(); go("schedule"); await update(); }, false, "sparkle");
  const fresh = () => { ctx.set(newEvent({ title: "", rounds: 3 })); openCard = "dinner"; go("setup"); };
  const arriving = ctx.incoming();
  const incomingCard = arriving ? h("div", { className: "c-card c-confirm", role: "alertdialog", "aria-label": "Open the dinner you sent" },
    h("h2", {}, `Open "${arriving.title || "your dinner"}" on this device?`),
    h("p", { className: "c-help" }, hasPeople(s) ? `It replaces "${s.title || "the dinner"}" in this browser. Download a copy of that first if you want to keep it.` : "It was sent from another device."),
    h("div", { className: "c-row" },
      h("button", { className: "c-button primary", onclick: () => { ctx.takeIncoming(true); render(true); } }, "Open it"),
      h("button", { className: "c-link", onclick: () => { ctx.takeIncoming(false); render(); } }, "Not now"))) : null;
  if (going) {
    const [label, act] = nextStep(s);
    const when = dateLine(s.night.date);
    const nPairs = pairCount(s);
    const daysOut = (() => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.night.date ?? ""); if (!m) return null; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d.getTime() - t.getTime()) / 864e5); })();
    const phoneTime = !!s.plan && !phone && ((daysOut !== null && daysOut <= 3 && daysOut >= 0) || (!!s.printed && daysOut === null));
    const steps: [Place, string][] = [...TABS, ["wrap", "Wrap up"]];
    return h("section", { className: "c-page c-home" },
      incomingCard,
      confirmNew ? h("div", { className: "c-card c-confirm", role: "alertdialog", "aria-label": "Start another dinner" },
        h("h2", {}, `Replace "${s.title || "your dinner"}"?`),
        h("p", { className: "c-help" }, "A new dinner replaces this one in this browser. Download a copy first if you want to keep it."),
        h("div", { className: "c-row" },
          h("button", { className: "c-button", onclick: () => { ctx.saveFile(); say("ok", "A copy was downloaded."); render(); } }, "Download a copy"),
          h("button", { className: "c-button primary", "data-k": "replace-dinner", onclick: () => { confirmNew = false; undoable(`Started a new dinner. "${s.title || "Your dinner"}" was replaced.`, fresh); } }, "Replace it"),
          h("button", { className: "c-link", onclick: () => { confirmNew = false; render(); } }, "Cancel"))) : null,
      phonePanel(),
      h("div", { className: "c-hero" },
        h("p", { className: "c-hero-when" }, icon("calendar"), when || "Your dinner"),
        h("h1", { tabindex: -1 }, s.title || "Your dinner"),
        h("p", { className: "c-hero-meta" }, [alumni(peopleCount(s)) + (nPairs ? ` (${nPairs} pair${nPairs !== 1 ? "s" : ""})` : ""), famsN(famsOf(s).length), `${s.rounds} round${s.rounds !== 1 ? "s" : ""}`].join(" \u00b7 ")),
        h("ol", { className: "c-steps", "aria-label": "Progress" }, steps.map(([key, name]) => {
          const st = key === "wrap" ? (eventOver(s) ? "ready" : "locked") : stateOf(key);
          const why = key === "wrap" ? "" : reasonFor(key);
          return h("li", { className: `${st} ${key === "wrap" ? "later" : ""}` },
            h("button", { className: "c-step-go", onclick: () => go(key), "aria-label": `${name}, ${STATE_WORDS[st]}${why ? `: ${why}` : ""}` },
              h("span", { className: "c-step-dot", "aria-hidden": "true" }, st === "done" ? icon("check") : ""),
              h("span", { className: "c-step-name", "aria-hidden": "true" }, name),
              h("span", { className: `c-step-time ${why && st === "attention" ? "warn" : ""}`, "aria-hidden": "true" }, why && st === "attention" ? why : STEP_TIME[key])));
        })),
        h("button", { className: "c-button primary big", "data-k": "next-step", onclick: act }, label, icon("chevron"))),
      phoneTime ? h("div", { className: "c-card c-phone-tip" }, icon("bell"), h("p", {}, "Running it from your phone on the night? "),
        h("button", { className: "c-link", onclick: () => startPhone() }, "Send this dinner to your phone")) : null,
      h("div", { className: "c-choices quiet" }, tourChoice(true, false), open, example),
      h("p", { className: "c-fine" }, "Everything stays in this browser. Nothing is sent anywhere."));
  }
  const picture = h("div", { className: "c-picture" });
  picture.innerHTML = PICTURE;
  return h("section", { className: "c-page c-home" },
    incomingCard,
    h("h1", { tabindex: -1 }, "Plan your rotation dinner"),
    h("p", { className: "c-lead" }, "Students stay at their table all night. Alumni, alone or in pairs, move to a new table each round. Paste your two lists, print what you need, and run the night from your phone."),
    picture,
    h("div", { className: "c-choices" },
      tourSeen() ? null : tourChoice(false, true),
      choice("Start a dinner", "Paste your lists or last year's seating chart from Docs, Sheets, or Excel.", fresh, tourSeen(), "plus"),
      example, open, tourSeen() ? tourChoice(false, false) : null),
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

/** Add a word to an alum's interests unless it is already there. */
function addInterest(r: CleanRow, word: string): void {
  const tags = (r.tags ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean);
  if (word && !tags.some((t) => t.toLowerCase() === word.toLowerCase())) r.tags = [word.toLowerCase(), ...tags].join("; ");
}

/** A table name nobody else uses. */
function freeLabel(s: EventState, base: string, except: CleanRow[] = []): string {
  const used = new Set(s.hosts.filter((r) => !except.includes(r)).map((r) => (r.table_label ?? "").trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Two alumni host one table together and move as one. */
function joinAlumni(s: EventState, a: CleanRow, b: CleanRow, label: string): void {
  const before = [a.table_label, b.table_label];
  a.host_name = [...peopleIn(whoAt(a)), ...peopleIn(whoAt(b))].join(" & ");
  for (const t of (b.tags ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean).reverse()) addInterest(a, t);
  a.table_label = label;
  for (const old of before) renameInRules(s, "host", old ?? "", label);
  s.hosts.splice(s.hosts.indexOf(b), 1);
}

/** A pair that should host apart: each alum gets their own table and keeps the pair's arrangements. */
function splitAlumni(s: EventState, r: CleanRow): void {
  const people = peopleIn(whoAt(r));
  if (people.length < 2) return;
  const label = (r.table_label ?? "").trim();
  const field = label && peopleIn(label).join(" & ") !== people.join(" & ") ? label.replace(/ \d+$/, "") : "";
  const rules = s.rules.filter((x) => (x.host_table ?? "").trim().toLowerCase() === label.toLowerCase() && x.by !== "grid");
  const rows = people.map((name, i) => (i === 0 ? r : { ...r, host_id: "", host_name: name }));
  rows.forEach((row, i) => {
    row.host_name = people[i];
    addInterest(row, field);
    row.table_label = freeLabel(s, people[i], [r]);
    if (i > 0) s.hosts.splice(s.hosts.indexOf(r) + i, 0, row);
  });
  renameInRules(s, "host", label, rows[0].table_label);
  for (const row of rows.slice(1)) for (const rule of rules) s.rules.push({ ...rule, host_table: row.table_label });
  tidy(s);
}

/**
 * After an import, alumni who share a field (from a column like "Industry",
 * or a table column) host one table together, two to a table. That is how
 * rotation dinners usually seat alumni, and the field is the planner's name
 * for the table. Anyone left over hosts alone under their own name.
 */
function pairByField(s: EventState): string[] {
  const groups = new Map<string, CleanRow[]>();
  for (const r of s.hosts) {
    const field = (r.table_label ?? "").trim(), who = (r.host_name ?? "").trim();
    if (!field || !who || field.toLowerCase() === who.toLowerCase() || peopleIn(who).length > 1) continue;
    groups.set(field.toLowerCase(), [...(groups.get(field.toLowerCase()) ?? []), r]);
  }
  const made: string[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const field = rows[0].table_label.trim();
    for (let i = 0; i + 1 < rows.length; i += 2) {
      joinAlumni(s, rows[i], rows[i + 1], i === 0 ? field : `${field} ${i / 2 + 1}`);
      made.push(`${rows[i].host_name} (${field})`);
    }
    if (rows.length % 2) { const r = rows[rows.length - 1]; addInterest(r, field); r.table_label = freeLabel(s, r.host_name.trim(), [r]); }
  }
  return made;
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
  if (kind === "hosts") paired = pairByField(s);
  ctx.persist();
  const words: Record<string, string> = { host_name: "names", table_label: "fields", tags: "interests", fam_label: "fam names", interests: "interests", table_number: "table numbers", students: "students" };
  const used = byName ? Object.entries(mapping).filter(([k]) => words[k]).map(([k, v]) => `${words[k]} from "${v}"`).join(", ") : "";
  const usedCols = new Set(Object.values(mapping));
  const ignored = byName ? grid[0].filter((c) => c.trim() && !usedCols.has(c) && !/e-?mail|phone|mobile/i.test(c)) : [];
  imported = { kind, skipped: header ? grid[0] : null, columns: used + (ignored.length ? `. We didn't use: ${ignored.map((c) => `"${c}"`).join(", ")}. If they hold late arrivals or stairs, add those under More options` : "") };
  noted(kind, `Added ${kind === "hosts" ? alumni(body.length) : famsN(body.length)}.` + (paired.length && kind === "hosts" ? ` Alumni who share a field host one table together: ${paired.join(", ")}. You can split a pair below.` : ""));
}

/** Say what a paste did inside the card it changed, with the first few names, and move on to the next card. */
function noted(card: "hosts" | "fams", text: string): void {
  const s = ev();
  const names = card === "hosts" ? hostsOf(s).map(whoAt) : famsOf(s).map((r) => r.fam_label);
  const preview = names.slice(0, 3).join(", ") + (names.length > 3 ? `, and ${names.length - 3} more` : "");
  cardNote = { card, text, preview };
  announce(text);
  openCard = null;
  const next = firstUndone(s);
  focusAfter = next ? `card-${next}` : `bar-setup`;
}

/** The first Set up card still to do, in order. */
function firstUndone(s: EventState): "dinner" | "hosts" | "fams" | null {
  if (!s.title.trim() && !hasPeople(s)) return "dinner";
  if (!hostsOf(s).length) return "hosts";
  if (!famsOf(s).length) return "fams";
  return null;
}

/** Last year's (or this year's) seating chart: the fams, the alumni and pairs, and who sat where. */
function importChart(chart: SeatingChart): void {
  const s = ev();
  const known = new Map(hostsOf(s).map((r) => [pairKey(whoAt(r)), r.tags ?? ""]));
  s.rounds = chart.rounds;
  s.fams = chart.fams.map((f) => ({ ...blankRow("fams"), table_number: f.table, fam_label: f.name, interests: f.interests.join("; ") }));
  s.hosts = chart.hosts.map((who) => ({ ...blankRow("hosts"), host_name: who, table_label: who, tags: known.get(pairKey(who)) ?? "" }));
  s.rules = [];
  tidy(s);
  for (const seat of chart.seats) placeInGrid(s, seat.host, seat.fam, seat.round);
  if (!s.title.trim()) s.title = "Alumni dinner";
  fromChart = true;
  paired = [];
  imported = null;
  ctx.persist();
  const n = peopleCount(s), pairs = pairCount(s);
  noted("hosts", `Read your seating chart: ${famsN(chart.fams.length)}, ${alumni(n)} at ${chart.hosts.length} tables${pairs ? ` (${pairs} pair${pairs !== 1 ? "s" : ""})` : ""}, ${chart.rounds} round${chart.rounds !== 1 ? "s" : ""}. The seating is kept exactly as you made it, and the chart gave your fams too.`);
}

/** A list of alumni with what they do: their interests are read from it, and emails are dropped. */
function importAlumniList(list: ListedAlum[]): void {
  const s = ev();
  const had = hostsOf(s).length > 0;
  const missing: string[] = [];
  let matched = 0;
  for (const a of list) {
    const words = a.interests.length ? a.interests : a.about ? [a.about.toLowerCase()] : [];
    const row = hostsOf(s).find((r) => peopleIn(whoAt(r)).some((p) => p.toLowerCase() === a.name.toLowerCase()));
    if (row) { for (const w of [...words].reverse()) addInterest(row, w); matched++; continue; }
    if (had) { missing.push(a.name); continue; }
    s.hosts.push({ ...blankRow("hosts"), host_name: a.name, table_label: a.name, tags: words.join("; ") });
  }
  tidy(s);
  ctx.persist();
  imported = null;
  noted("hosts", (had ? `Added what ${matched} of ${alumni(list.length)} do, as interests for matching.` : `Added ${alumni(list.length)} with what they do as interests.`)
    + (missing.length ? ` Not in your seating, so left out: ${missing.join(", ")}.` : "") + " Emails are never kept.");
}

/** Read a seating chart or an alumni list if that is what was pasted. True when it was. */
function importWhatTheyHave(plain: string, grid: string[][] | null): boolean {
  const chart = grid ? readSeatingChart(grid) : null;
  if (chart) { undoable("Read your seating chart.", () => importChart(chart)); return true; }
  const list = readAlumniList(plain);
  if (list) { undoable("Added your alumni list.", () => importAlumniList(list)); return true; }
  return false;
}

/** Fill a list from the STEW 2026 example, in the format shown, to see what a paste does. */
function useExample(kind: "hosts" | "fams"): void {
  if (format === "chart") { importWhatTheyHave("", stewChartGrid()); return; }
  if (kind === "hosts" && format === "list") { undoable("Added the example alumni list.", () => importAlumniList(STEW_PEOPLE.map(([name, about]) => ({ name, about, interests: careerWords(about) })))); return; }
  undoable(kind === "hosts" ? "Added the example alumni." : "Added the example fams.", () => addRows(kind, kind === "hosts"
    ? STEW_TABLES.map(([, who]) => [who, stewInterests(who).join("; ")])
    : STEW_FAMS.map(([n, fam, majors]) => [n, fam, majorWords(majors).join("; ")])));
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

const SAMPLES: Record<"chart" | "list" | "lines", { hosts: string[][]; fams: string[][]; placeholder: [string, string] }> = {
  chart: {
    hosts: [["Fam table", "Round 1", "Round 2"], ["Table 1 \u00b7 Fam 6 (PoliSci/Comm)", "Kenneth Tran", "Sally Lew"], ["Table 2 \u00b7 Fam 3 (Cog Sci/Math)", "Dan Tran + Alex Lim", "Uyen Tran + Carolyn Nguyen"]],
    fams: [["Fam table", "Round 1", "Round 2"], ["Table 1 \u00b7 Fam 6 (PoliSci/Comm)", "Kenneth Tran", "Sally Lew"], ["Table 2 \u00b7 Fam 3 (Cog Sci/Math)", "Dan Tran + Alex Lim", "Uyen Tran + Carolyn Nguyen"]],
    placeholder: ["Select the whole seating chart in your doc or sheet, copy it, and paste here.", "Select the whole seating chart in your doc or sheet, copy it, and paste here."],
  },
  list: {
    hosts: [["Dan Tran: email address"], ["Practicing internist"], ["Sally Lew: email address"], ["Nonprofit consulting and education reform"]],
    fams: [],
    placeholder: ["Dan Tran: dan@example.com\nPracticing internist", ""],
  },
  lines: {
    hosts: [["Willy Teav", "engineering; aerospace"], ["David Ho", "engineering; computer science"]],
    fams: [["1", "Fam 6", "political science; communications"], ["2", "Fam 3", "cognitive science; math"]],
    placeholder: ["Willy Teav, engineering; aerospace\nDavid Ho, engineering; computer science", "Fam 6, political science; communications\nFam 3, cognitive science; math"],
  },
};

/** The three things coordinators paste, each with real rows to show what it looks like. */
function formatPicker(kind: "hosts" | "fams"): HTMLElement {
  const options: ["chart" | "list" | "lines", string][] = kind === "hosts"
    ? [["chart", "Seating chart"], ["list", "Alumni list"], ["lines", "One per line"]]
    : [["chart", "Seating chart"], ["lines", "One per line"]];
  const shown = options.some(([k]) => k === format) ? format : "lines";
  const rows = SAMPLES[shown][kind];
  return h("div", { className: "c-format" },
    h("div", { className: "c-round-switch", role: "group", "aria-label": "What will you paste?" }, options.map(([k, label]) =>
      h("button", { className: `c-seg ${shown === k ? "on" : ""}`, "aria-pressed": shown === k ? "true" : "false", "data-k": `format-${kind}-${k}`, onclick: () => { format = k; render(); } }, label))),
    h("div", { className: "c-sample", role: "figure", tabindex: 0, "aria-label": `Example of ${options.find(([k]) => k === shown)![1].toLowerCase()}` },
      h("table", {}, rows.map((r, i) => h("tr", { className: shown === "chart" && i === 0 ? "head" : shown === "list" && i % 2 ? "sub" : "" }, r.map((c) => h("td", {}, c)))))),
    h("p", { className: "c-help" }, shown === "chart" ? "Last year's (or this year's) chart: one row per fam table, a column per round, pairs written \"A + B\". The app keeps that seating."
      : shown === "list" ? "A name and email on one line, what they do on the next. Emails are dropped; what they do becomes interests for matching."
      : kind === "hosts" ? "One alum per line: their name, then what they can talk about." : "One fam per line: an optional table number, its name, then its majors. Shorthand like PoliSci or Bio/Chem is understood.",
      " ", h("button", { className: "c-link small", "data-k": `example-${kind}`, onclick: () => { useExample(kind); adding = null; render(); } }, "Use the STEW 2026 example to see how it works"),
      shown === "chart" ? [" \u00b7 ", h("button", { className: "c-link small", onclick: () => download("Seating chart template.csv", "Fam table,Round 1 (alums),Round 2 (alums)\nTable 1 Fam name (majors),Name or Name + Name,Name\n") }, "Download a blank seating chart")] : null));
}

function pasteBox(kind: "hosts" | "fams"): HTMLElement {
  const shown = kind === "fams" && format === "list" ? "lines" : format;
  const id = `c-paste-${kind}`;
  const box = h("textarea", { id, rows: 5, className: "c-paste", placeholder: SAMPLES[shown].placeholder[kind === "hosts" ? 0 : 1], "aria-describedby": `${id}-help` }) as HTMLTextAreaElement;
  const add = h("button", { className: "c-button primary", hidden: true, onclick: () => {
    const grid = typedGrid(box.value);
    if (!grid.length) return;
    if (!importWhatTheyHave(box.value, grid)) undoable(kind === "hosts" ? "Added alumni." : "Added fams.", () => addRows(kind, grid));
    adding = null;
    render();
  } }, "Add these");
  box.addEventListener("input", () => { add.hidden = !box.value.trim(); });
  box.addEventListener("paste", (e) => {
    const data = (e as ClipboardEvent).clipboardData;
    const plain = data?.getData("text/plain") ?? "";
    const grid = gridFromHtml(data?.getData("text/html") ?? "") ?? parsePasted(plain);
    if (importWhatTheyHave(plain, grid)) { e.preventDefault(); adding = null; render(); return; }
    if (!grid) return;
    e.preventDefault();
    undoable(kind === "hosts" ? "Added alumni." : "Added fams.", () => addRows(kind, grid));
    adding = null;
    render();
  });
  return h("div", { className: "c-paste-zone" },
    formatPicker(kind),
    h("label", { for: id, className: "c-label" }, kind === "hosts" ? "Paste or type your alumni" : "Paste or type your fams"),
    h("div", { className: "c-paste-wrap" }, box, pasteDemo()),
    h("p", { id: `${id}-help`, className: "c-help" }, "Copy from Google Docs, Sheets, or Excel and paste here, or type."),
    h("div", { className: "c-row" }, add, uploadButton(kind),
      ev()[kind].length ? h("button", { className: "c-link", onclick: () => { adding = null; render(); } }, "Cancel") : null));
}

/** Once, the first time an empty paste box is shown: a sheet slides in and becomes a list. Any key or click stops it. */
function pasteDemo(): HTMLElement | null {
  try { if (localStorage.getItem("rotation-optimizer:paste-demo")) return null; localStorage.setItem("rotation-optimizer:paste-demo", "1"); } catch { return null; }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const demo = h("div", { className: "c-paste-demo", "aria-hidden": "true" },
    h("div", { className: "c-demo-sheet" }, ["Fam table", "Round 1", "Round 2"].map((c) => h("span", {}, c)), ["Table 1", "K. Tran", "S. Lew"].map((c) => h("span", {}, c)), ["Table 2", "D. Tran + A. Lim", "U. Tran"].map((c) => h("span", {}, c))),
    h("div", { className: "c-demo-list" }, h("span", {}, "\u2713 10 fams"), h("span", {}, "\u2713 13 alumni, 3 pairs")));
  const stop = () => { demo.remove(); removeEventListener("keydown", stop, true); removeEventListener("pointerdown", stop, true); };
  addEventListener("keydown", stop, true);
  addEventListener("pointerdown", stop, true);
  demo.addEventListener("animationend", (e) => { if ((e as AnimationEvent).animationName === "c-demo-out") stop(); });
  return demo;
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
    if (kind === "hosts") paired = pairByField(s);
    ctx.persist();
    adding = null;
    noted(kind, `Read ${kind === "hosts" ? alumni(clean.length) : famsN(clean.length)} from ${f.name}` + (grouped ? `, grouping ${grouped} student answers by fam.` : ".") + " Email and phone columns are never kept.");
    render();
  });
  return keyOpens(h("label", { className: "c-button", for: id, tabindex: 0 }, input, "Upload a CSV"));
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
          row ? h("button", { className: "c-x", "aria-label": `Remove row ${i + 1}`, onclick: () => { const gone = (kind === "hosts" ? whoAt(r) : r.fam_label) || `row ${i + 1}`; undoable(`Removed ${gone}.`, () => { rows().splice(i, 1); ctx.persist(); }); render(); } }, "×") : h("span", { className: "x" }));
      }));
  };
  draw();
  return list;
}

function readList(kind: "hosts" | "fams"): HTMLElement {
  const s = ev();
  const split = (t: string) => (t ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean).join(", ");
  if (kind === "hosts") {
    return h("ul", { className: "c-read", "data-kind": "hosts" }, hostsOf(s).map((r) => {
      const who = whoAt(r);
      const pair = peopleIn(who).length > 1;
      return h("li", { className: pair ? "pair" : "" },
        avatars(who),
        h("span", { className: "who" }, who),
        pair ? h("button", { className: "c-link small", "aria-label": `Split ${who} so each hosts alone`, onclick: () => { undoable(`Split ${who}: each now hosts alone.`, () => { splitAlumni(s, r); paired = []; ctx.persist(); }); render(); } }, "Split") : null,
        h("span", { className: "what" }, [r.table_label && r.host_name && r.table_label !== r.host_name ? r.table_label : "", split(r.tags)].filter(Boolean).join(" · ") || "no interests yet"),
        settingsWords(s, r.host_id).map((w) => h("span", { className: "c-tag" }, w)));
    }));
  }
  const tables = roomTables(s);
  return h("ul", { className: "c-read", "data-kind": "fams" }, famsOf(s).map((r) => h("li", {},
    h("span", { className: "c-num" }, String(tables[r.fam_id] ?? "")),
    h("span", { className: "who" }, r.fam_label),
    h("span", { className: "what" }, split(r.interests) || "no interests yet"),
    /^(y|yes|true|1)$/i.test((r.step_free ?? "").trim()) ? h("span", { className: "c-tag" }, "step-free") : null)));
}

const CARD_STEP = { dinner: 1, hosts: 2, fams: 3 } as const;

/** One Set up step: numbered, open one at a time, a done step folding to one line with what it holds. */
function setupCard(key: "dinner" | "hosts" | "fams", title: string, summary: string, done: boolean, body: () => (HTMLElement | null)[]): HTMLElement {
  const isOpen = openCard === key || (openCard === null && firstUndone(ev()) === key);
  const note = cardNote && cardNote.card === key ? h("div", { className: "c-msg ok c-card-note", role: "status" },
    h("p", {}, cardNote.text), cardNote.preview ? h("p", { className: "c-help" }, `First in the list: ${cardNote.preview}.`) : null,
    h("div", { className: "c-row" },
      h("button", { className: "c-button", "data-k": `looks-right-${key}`, onclick: () => { cardNote = null; render(); } }, "Looks right"),
      undoSnap ? h("button", { className: "c-link", onclick: undoLast }, "Undo") : null)) : null;
  return h("section", { className: `c-card c-setup ${done ? "done" : ""} ${isOpen ? "open" : ""}`, "data-card": key },
    h("h2", { className: "c-card-h" }, h("button", { className: "c-card-head", "aria-expanded": isOpen ? "true" : "false", "data-k": `card-${key}`, onclick: () => { openCard = isOpen ? (done ? null : key) : key; render(); } },
      h("span", { className: `c-check ${done ? "on" : ""}`, "aria-hidden": "true" }, done ? icon("check") : String(CARD_STEP[key])),
      h("span", { className: "c-card-title" }, title, h("span", { className: "visually-hidden" }, `, step ${CARD_STEP[key]} of 3${done ? ", done" : ""}`)),
      h("span", { className: "c-card-summary" }, done && !isOpen ? summary : ""),
      icon("chevron", `c-chev ${isOpen ? "up" : "down"}`))),
    note,
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

/** Once both lists are in: how many fams share a word with some alum, and which share none. */
function matchHint(s: EventState): HTMLElement | null {
  const fams = famsOf(s), hosts = hostsOf(s);
  if (!fams.length || !hosts.length) return null;
  const words = (t: string) => (t ?? "").split(/[;,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const alumWords = new Set(hosts.flatMap((r) => words(r.tags)));
  if (!alumWords.size) return h("p", { className: "c-match-hint some" }, "Your alumni have no interests yet, so the app can't match them to fams. Paste your alumni list (names with what each does) under Alumni, or keep the seating you already have.");
  const lonely = fams.filter((f) => !words(f.interests).some((w) => alumWords.has(w)));
  const ok = fams.length - lonely.length;
  return h("p", { className: `c-match-hint ${lonely.length ? "some" : "all"}` },
    `${ok} of ${famsN(fams.length)} share an interest word with at least one alum.`,
    lonely.length ? ` ${lonely.slice(0, 3).map((f) => f.fam_label).join(", ")}${lonely.length > 3 ? ` and ${lonely.length - 3} more` : ""} ${lonely.length === 1 ? "shares" : "share"} none yet, so ${lonely.length === 1 ? "it gets" : "they get"} the closest match. Matching counts identical words, like "biology" on both sides.` : "");
}

function setupPage(): HTMLElement {
  const s = ev();
  const nHosts = hostsOf(s).length, nFams = famsOf(s).length;
  const name = h("input", { id: "c-name", type: "text", value: s.title, placeholder: "Alumni dinner" }) as HTMLInputElement;
  name.addEventListener("input", () => { s.title = name.value; ctx.persist(); const t = document.querySelector(".c-title"); if (t) t.textContent = s.title || "Your dinner"; });
  const rounds = h("select", { id: "c-rounds" }, [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: n, selected: n === s.rounds }, `${n} round${n !== 1 ? "s" : ""}`))) as HTMLSelectElement;
  rounds.addEventListener("change", () => { s.rounds = Number(rounds.value); s.finished = Math.min(s.finished, s.rounds - 1); ctx.persist(); });
  const have = (k: "chart" | "list" | "lines", label: string) => h("button", { className: `c-chip ${format === k ? "on" : ""}`, "aria-pressed": format === k ? "true" : "false", onclick: () => { format = k; render(); } }, label);
  const date = h("input", { id: "c-date", type: "date", value: s.night.date ?? "" }) as HTMLInputElement;
  date.addEventListener("change", () => { s.night = { ...s.night, date: date.value || undefined }; ctx.persist(); });
  const nPeople = peopleCount(s), nPairs = pairCount(s);
  const solos = hostsOf(s).filter((r) => peopleIn(whoAt(r)).length === 1);
  const pairPick = (label: string, value: string, skip: string, onPick: (v: string) => void) => {
    const sel = h("select", { "aria-label": label }, h("option", { value: "" }, "Choose…"),
      solos.filter((r) => r.host_id !== skip).map((r) => h("option", { value: r.host_id, selected: r.host_id === value }, whoAt(r)))) as HTMLSelectElement;
    sel.addEventListener("change", () => onPick(sel.value));
    return sel;
  };
  const partner = h("select", { "aria-label": "Second alum of the pair", disabled: !pairA }, h("option", { value: "" }, "Choose…"),
    solos.filter((r) => r.host_id !== pairA).map((r) => h("option", { value: r.host_id }, whoAt(r)))) as HTMLSelectElement;
  const pairBox = solos.length > 1 ? h("div", { className: "c-inset" },
    h("p", { className: "c-label" }, "Two alumni hosting one table together"),
    h("div", { className: "c-row" }, pairPick("First alum of the pair", pairA, "", (v) => { pairA = v; render(); }), h("span", {}, "and"), partner,
      h("button", { className: "c-button", onclick: () => {
        const a = s.hosts.find((r) => r.host_id === pairA), b = s.hosts.find((r) => r.host_id === partner.value);
        if (!a || !b) return;
        const fa = (a.table_label ?? "").trim(), fb = (b.table_label ?? "").trim();
        const shared = fa && fa.toLowerCase() === fb.toLowerCase() && fa !== whoAt(a) ? fa : `${whoAt(a)} & ${whoAt(b)}`;
        let who = "";
        undoable("Paired them.", () => { joinAlumni(s, a, b, freeLabel(s, shared, [a, b])); who = whoAt(a); pairA = ""; tidy(s); ctx.persist(); });
        say("ok", `${who} now host one table together.`);
        render();
      } }, "Pair them")),
    h("p", { className: "c-help" }, "They move together, so each fam meets them both at once.")) : null;
  const dinnerDone = nHosts > 0 || nFams > 0 || !!s.title.trim();
  const hint = matchHint(s);
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
  const fresh = !nHosts || !nFams;
  return h("section", { className: "c-page" },
    h("h1", { tabindex: -1 }, fresh && !hasPeople(s) ? "Let's set up your dinner" : "Set up"),
    fresh ? h("p", { className: "c-lead" }, "Three short steps. Most coordinators paste a seating chart or an alumni list they already have. ",
      ctx.inPractice() ? null : h("button", { className: "c-link", onclick: async () => { practiceReturn = "setup"; ctx.tryExample(); go("schedule"); await update(); } }, "See the STEW 2026 dinner first")) : null,
    problems.length ? h("div", { className: "c-msg error", role: "alert" }, h("strong", {}, "Before making the schedule:"), h("ul", {}, problems.map((p) => h("li", {}, plain(p))))) : null,
    setupCard("dinner", "Your dinner", `${s.title || "Alumni dinner"} · ${s.rounds} round${s.rounds !== 1 ? "s" : ""}`, dinnerDone, () => [
      h("div", { className: "c-fields" },
        h("div", { className: "c-field" }, h("label", { for: "c-name", className: "c-label" }, "Name"), name),
        h("div", { className: "c-field" }, h("label", { for: "c-rounds", className: "c-label" }, "Rounds"), rounds,
          h("span", { className: "c-help" }, "Alumni move to a new fam each round. 2 rounds suit about 90 minutes; 3 suit about 2 hours.")),
        h("div", { className: "c-field" }, h("label", { for: "c-date", className: "c-label" }, "Date (optional)"), date,
          h("span", { className: "c-help" }, "Shows a countdown on the home page."))),
      hasPeople(s) ? null : h("div", { className: "c-have" }, h("p", { className: "c-label" }, "What do you have for the lists?"),
        h("div", { className: "c-row" }, have("chart", "Last year's seating chart"), have("list", "A list of alumni"), have("lines", "Nothing yet"))),
      h("button", { className: "c-button primary", "data-k": "next-alumni", onclick: () => { if (!s.title.trim()) s.title = "Alumni dinner"; ctx.persist(); openCard = nHosts ? null : "hosts"; focusAfter = "card-hosts"; render(); } }, "Next: your alumni"),
    ]),
    setupCard("hosts", "Alumni", alumni(nPeople) + (nPairs ? ` at ${nHosts} tables · ${nPairs} pair${nPairs !== 1 ? "s" : ""}` : "") + (special.length ? ` · ${special.length} with special arrangements` : ""), nHosts > 0, () => [
      importNote("hosts"),
      fromChart && gridChanges(s).length ? h("p", { className: "c-note" }, "The seating from your chart is kept as you made it. ",
        h("button", { className: "c-link", onclick: () => { undoable("The app will re-seat everyone by interests.", () => { clearGrid(s); fromChart = false; ctx.persist(); }); render(); } }, "Let the app re-seat everyone by interests"),
        hostsOf(s).some((r) => !(r.tags ?? "").trim()) ? h("span", { className: "c-help" }, " To match by interests, paste your alumni list too: names with what each one does.") : null) : null,
      paired.length ? h("p", { className: "c-note" }, `Alumni who share a field host one table together: ${paired.join(", ")}. Tap Split on any pair that should host alone.`) : null,
      editing === "hosts" ? peopleList("hosts", moreHosts ? [...ALUMNI_COLS, TOPIC_COL] : ALUMNI_COLS) : nHosts && adding !== "hosts" ? readList("hosts") : pasteBox("hosts"),
      listButtons("hosts", nHosts),
      nHosts ? h("div", { className: "c-row c-card-nav" },
        h("button", { className: "c-link", onclick: () => { openCard = "dinner"; render(); } }, "\u2039 Back: your dinner"),
        nFams ? null : h("button", { className: "c-button primary", "data-k": "next-fams", onclick: () => { openCard = "fams"; focusAfter = "card-fams"; render(); } }, "Next: your fams")) : null,
      nHosts ? more(moreHosts, () => { moreHosts = !moreHosts; render(); }, "More options",
        pairBox,
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
      h("div", { className: "c-row c-card-nav" }, h("button", { className: "c-link", onclick: () => { openCard = "hosts"; render(); } }, "\u2039 Back: alumni")),
      nFams ? more(moreFams, () => { moreFams = !moreFams; render(); }, "More options",
        h("p", {}, "Student names print a find-your-table page. Where in the room prints on alumni cards."),
        editing === "fams" ? null : h("button", { className: "c-link", onclick: () => { editing = "fams"; render(); } }, "Add students or where each table is")) : null,
    ]),
    hint);
}

/** Check the lists, then make (or update) the schedule. */
async function makeSchedule(): Promise<void> {
  const s = ev();
  const nHosts = hostsOf(s).length, nFams = famsOf(s).length;
  tidy(s);
  problems = [...new Set(checkInputs({ ...s, rules: [] }).problems)];
  const stairs = s.hosts.find((r) => hostSettings(s, r.host_id).stepFree);
  if (stairs && !stepFreeFams(s).length) { problems.push(`${stairs.host_name || stairs.table_label} can't use stairs: tick at least one step-free table under Alumni, More options.`); moreHosts = true; noteFor = stairs.host_id; openCard = "hosts"; }
  if (s.rounds > maxRounds(s)) problems.push(`With ${nHosts} alumni tables and ${famsN(nFams)}, at most ${maxRounds(s)} rounds can run without a fam meeting the same alum twice. Choose fewer rounds.`);
  if (problems.length) { render(); (document.querySelector("#main .c-msg.error") as HTMLElement | null)?.scrollIntoView({ block: "center" }); return; }
  if (!s.title.trim()) s.title = "Alumni dinner";
  ctx.persist();
  go("schedule");
  await update();
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
  const rounds = Array.from({ length: p.rounds }, (_, k) => k + 1);
  const seated = p.fams.every((f) => rounds.every((r) => (p.famAway[f.groupId] ?? []).includes(r) || p.assignments.some((a) => a.round === r && a.groupId === f.groupId)));
  const pairs = p.hosts.some((x) => peopleIn(x.person || x.name).length > 1);
  const meets = (n: number) => (pairs ? `${n} alumni table${n !== 1 ? "s" : ""}` : alumni(n));
  const lines = [
    (seated ? "Everyone has a seat. " : "") + (lo === hi ? `Each fam meets ${meets(lo)}, a different one each round.` : `Each fam meets ${lo} to ${meets(hi)}, a different one each round.`),
    anyInterests && weak ? `${weak === 1 ? "One pairing is" : `${weak} of ${p.assignments.length} pairings are`} a weaker match: the alum and fam share no interest word.` +
      (weak * 2 > p.assignments.length ? " Matches only count identical words, so using the same words in both lists (for example \"computer science\" in both, not \"CS\" in one) gives better matches." : "") : "",
    provenOptimal(p) ? (p.keptSlots !== null ? "This is the best update, changing as little as possible." : "With these words, no other schedule shares more interests.") : "",
  ].filter(Boolean);
  return h("div", { className: "c-answer" }, h("span", { className: "c-answer-mark", "aria-hidden": "true" }, icon("check")),
    h("div", {}, h("p", { className: "c-answer-main" }, lines[0]),
      lines.length > 1 ? h("button", { className: "c-link small", "aria-expanded": showMatches ? "true" : "false", "data-k": "matches", onclick: () => { showMatches = !showMatches; render(); } }, showMatches ? "Hide" : "How good are the matches?") : null,
      showMatches ? lines.slice(1).map((l) => h("p", { className: "c-help" }, l)) : null));
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
  if (busy) return h("section", { className: "c-page" }, h("h1", { tabindex: -1 }, "Schedule"),
    h("ol", { className: "c-build", role: "status", "aria-label": "Seating everyone" },
      ["Matching interests", "Avoiding repeat visits", "Checking who is here when", "Getting the printouts ready"].map((t, i) => h("li", { style: `--i: ${i}` }, h("span", { className: "c-build-tick", "aria-hidden": "true" }), t))));
  if (!p) return emptyPage("schedule");
  const current = isCurrent(s);
  const attention = needsYou(p);
  const mine = gridChanges(s);
  const tips = nearMisses(s.hosts, s.fams);
  return h("section", { className: "c-page" },
    h("div", { className: "c-head-row" }, h("h1", { tabindex: -1 }, "Schedule"),
      current ? h("button", { className: `c-button ${adjust ? "primary" : ""}`, "aria-pressed": adjust ? "true" : "false", "data-k": "adjust", onclick: () => { adjust = !adjust; picked = null; why = false; render(); } }, adjust ? "Done adjusting" : [icon("swap"), "Adjust"]) : null),
    current ? null : h("div", { className: "c-msg warn" }, "Your lists changed since this schedule was made. Update it with the button below."),
    summary(p),
    changed.length ? h("div", { className: "c-msg info" }, h("strong", {}, "What moved:"), h("ul", {}, changed.map((c) => h("li", {}, c)))) : null,
    attention.length ? h("div", { className: "c-msg warn" }, h("strong", {}, "Needs you"), h("ul", {}, attention)) : null,
    adjust ? adjustBar(p) : null,
    adjust ? null : roundSwitch(p),
    adjust || !showRound || showRound > p.rounds ? roomPlan(p, current) : room(p, showRound),
    whoSitsOut(p),
    adjust && mine.length ? h("p", { className: "c-help" }, `${alumni(mine.length)} placed by hand. `,
      h("button", { className: "c-link", onclick: async () => { clearGrid(s); ctx.persist(); await update(); } }, "Undo my changes")) : null,
    more(moreSchedule, () => { moreSchedule = !moreSchedule; render(); }, "More options",
      h("p", { className: "c-help" }, "To change who sits where, tap Adjust above."),
      tips.length ? h("div", {}, h("p", {}, "These look like the same interest, but only identical words count as a match:"),
        tips.map((m) => h("div", { className: "c-row" }, h("span", {}, m.spellings.join(" and ")),
          h("button", { className: "c-button", onclick: async () => { applySpelling(s, m); ctx.persist(); await update(); } }, `Use "${m.suggestion}" for all`)))) : null,
      p.warnings.length ? h("details", {}, h("summary", {}, "Notes about this schedule"), h("ul", {}, p.warnings.map((w) => h("li", {}, warningWords(w))))) : null,
      !adjust && mine.length ? h("button", { className: "c-link", onclick: async () => { clearGrid(s); ctx.persist(); await update(); } }, `Undo the ${mine.length} change${mine.length !== 1 ? "s" : ""} you made by hand`) : null));
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
  if (!picked) return h("div", { className: "c-adjust" }, swapSaved ? h("p", { className: "c-saved-note" }, icon("check"), " Swap saved. ") : null,
    h("p", {}, "Tap an alum, then another alum or an empty seat in the same round. They swap, and everything else stays where it can."));
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
  return h("div", { className: "c-plan-wrap" }, h("div", { className: `c-plan ${adjust ? "adjusting" : ""}`, role: "table", "aria-label": "Who sits at each table, each round", style: `--rounds: ${p.rounds}` },
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
            h("span", { className: "c-round-tag", "aria-hidden": "true" }, `R${r}`), h("span", { className: "c-seat-name" }, label));
        }
        const pinned = !!host && byHand.has(`${r}|${f.name.toLowerCase()}|${host.name.toLowerCase()}`);
        const isPicked = picked?.round === r && picked.famId === f.groupId;
        const can = current && !locked.has(r) && r > s.finished && !gone && !busy;
        const blocked = !!picked && picked.round === r && !isPicked && can ? swapBlock(p, r, picked.famId, f.groupId) : "";
        return h("span", { role: "cell", className: "c-seat-cell", "data-round": r },
          h("button", {
            className: `c-seat-button ${host ? "" : "empty"} ${isPicked ? "picked" : ""} ${picked && picked.round === r && !isPicked && !blocked ? "target" : ""} ${blocked ? "blocked" : ""}`,
            disabled: !can, "aria-disabled": blocked ? "true" : null, "aria-pressed": isPicked ? "true" : "false", "data-round": r,
            "aria-label": `Table ${tables[f.groupId]}, ${f.name}, round ${r}: ${label}${weak ? ", weaker match" : ""}${pinned ? ", placed by hand" : ""}${blocked ? `. Not possible: ${blocked}` : ""}`,
            "data-k": `seat-${r}-${f.groupId}`, title: blocked || null,
            onclick: () => { if (blocked) { say("info", blocked); render(); return; } tapSeat(p, r, f.groupId); },
          }, h("span", { className: "c-round-tag", "aria-hidden": "true" }, `R${r}`), h("span", { className: "c-seat-name" }, label), pinned ? h("span", { className: "c-pin", "aria-hidden": "true" }, "placed") : null,
            blocked ? h("span", { className: "c-blocked-note", "aria-hidden": "true" }, "not possible") : null));
      })))));
}

/** Round 1, Round 2, … or the whole night as a grid. */
function roundSwitch(p: EventPlan): HTMLElement {
  const show = showRound > p.rounds ? 0 : showRound;
  const rounds = Array.from({ length: p.rounds }, (_, k) => k + 1);
  return h("div", { className: "c-round-switch", role: "group", "aria-label": "Show" },
    [...rounds, 0].map((r) => h("button", { className: `c-seg ${show === r ? "on" : ""}`, "aria-pressed": show === r ? "true" : "false", "data-k": `show-${r}`,
      onclick: () => { showRound = r; render(); } }, r ? `Round ${r}` : "Whole night")));
}


/** The room in one round: each table drawn with its fam and the alum or pair sitting there. */
function room(p: EventPlan, r: number): HTMLElement {
  const s = ev();
  const tables = tableNumbers(p);
  const list = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  return h("ul", { className: "c-plan c-room", "aria-label": `Round ${r}${r <= s.finished ? " (done)" : ""}: who sits at each table` },
    list.map((f) => {
      const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
      const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
      const gone = (p.famAway[f.groupId] ?? []).includes(r);
      const who = host ? host.person || host.name : "";
      const n = tables[f.groupId];
      return h("li", { className: `c-tile c-seat ${host ? "" : "empty"}`, "data-round": r, style: `--h: ${famHue(n)}` },
        h("span", { className: "c-disc", "aria-hidden": "true" }, String(n)),
        h("span", { className: "c-tile-text" },
          h("span", { className: "c-tile-fam" }, h("span", { className: "visually-hidden" }, `Table ${n}, `), f.name),
          host ? h("span", { className: "c-tile-who" }, avatars(who), h("span", { className: "c-seat-name" }, who))
            : h("span", { className: "c-tile-who c-seat-name" }, gone ? "Fam not here this round" : "No alum this round")));
    }));
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
  if (!picked || picked.round !== r) { picked = { round: r, famId }; why = false; swapSaved = false; render(); return; }
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
  swapSaved = isCurrent(s);
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
  const recorded = () => { ctx.markPrinted(); };
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
    printedOk ? h("div", { className: "c-answer" }, h("span", { className: "c-answer-mark", "aria-hidden": "true" }, icon("check")),
      h("div", {}, h("p", { className: "c-answer-main" }, "You are ready for the event."), h("p", { className: "c-help" }, `Printed${s.printedAt ? ` at ${s.printedAt}` : ""}. From now on, any change tells you exactly which pages to reprint, so you never reprint everything.`))) : null,
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
    h("ul", { className: "c-docs" }, list.map((d) => {
      const changedDoc = reprint.length && s.printed && ((d.label === "Room chart" && reprintList(s.printed, p).seatingChart) || (d.label === "Alumni cards" && reprintList(s.printed, p).hostIds.length) || (d.label === "Table numbers" && reprintList(s.printed, p).famIds.length));
      const done = opened.plan === p && opened.docs.has(d.label);
      return h("li", { className: `${changedDoc ? "changed" : ""} ${done ? "opened" : ""}` },
        h("button", { className: "c-doc-hit", "data-k": `doc-${d.label}`, "aria-label": `Open the ${d.label.toLowerCase()} as a PDF${done ? ", opened" : ""}`, onclick: () => openDoc(d) }),
        changedDoc ? h("span", { className: "c-reprint-tag" }, "Reprint") : done ? h("span", { className: "c-opened-tag" }, icon("check"), "Opened") : null,
        thumb(d.make(), d.label),
        h("div", { className: "c-doc-text" }, h("strong", {}, d.label), h("span", { className: "c-help" }, d.purpose), h("span", { className: "c-pages" }, `About ${d.pages} page${d.pages !== 1 ? "s" : ""}`),
          h("span", { className: "c-doc-open", "aria-hidden": "true" }, icon("printer"), "Open as PDF")));
    })),
    h("p", { className: "c-help" }, `Tap a printout to open it on its own; the print window opens with it, where Save as PDF makes the file. Print everything does all of them at once, about ${total} pages in all (US Letter, 100% scale).`,
      printedOk ? [" ", h("button", { className: "c-link small", onclick: printEverything }, "Print everything again")] : null,
      !s.printed ? [" ", h("button", { className: "c-link small", onclick: () => go("run") }, "Skip printing for now")] : null),
    more(morePrint, () => { morePrint = !morePrint; render(); }, "More options",
      h("div", { className: "c-fields" },
        h("div", { className: "c-field" }, h("label", { for: "c-print-name", className: "c-label" }, "Name on every page"), name),
        h("div", { className: "c-field" }, h("label", { for: "c-doors", className: "c-label" }, "Doors open (adds times to the run sheet)"), doors),
        h("div", { className: "c-field" }, h("label", { for: "c-minutes", className: "c-label" }, "Each round lasts"), minutes)),
      h("p", { className: "c-label" }, "Print one at a time"),
      h("ul", { className: "c-plain-list" }, [...list.map((d): [string, string, () => string] => [d.label, d.purpose.charAt(0).toLowerCase() + d.purpose.slice(1), d.make]), ...extra].map(([label, purpose, make]) =>
        h("li", {}, h("button", { className: "c-link", onclick: () => openPage(make()) }, label), h("span", { className: "c-help" }, `: ${purpose.replace(/\.$/, "")}`))))));
}

/** One printout on its own, named for the event, with the print window (and Save as PDF) open. Once all four are opened, the app counts it as printed. */
function openDoc(d: Doc): void {
  const s = ev();
  if (!s.plan) return;
  if (!s.title.trim()) s.title = "Alumni dinner";
  openPage(printEverythingHtml(`${s.title}: ${d.label}`, [[d.label, d.make()]], true));
  if (opened.plan !== s.plan) opened = { plan: s.plan, docs: new Set() };
  opened.docs.add(d.label);
  if (opened.docs.size === docs(s, s.plan).length && !(s.printed && isCurrent(s) && !reprintNeeded(s).length)) ctx.markPrinted();
  render();
}

function printEverything(): void {
  const s = ev();
  if (!s.plan) return;
  if (!s.title.trim()) s.title = "Alumni dinner";
  openPage(printEverythingHtml(s.title, docs(s, s.plan).map((d) => [d.label, d.make()])));
  ctx.markPrinted();
  render();
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
      h("button", { className: "c-link", "data-k": "run-back", onclick: () => {
        if (status(s, nowMinutes()).phase === "during" && !leaveRun) { leaveRun = true; render(); return; }
        go("home");
      } }, "\u2039 Back to planning"),
      h("strong", {}, s.title || "Your dinner"),
      ctx.inPractice() ? h("span", { className: "c-pill practice" }, "Practice ", h("button", { className: "c-link", onclick: () => ctx.endPractice() }, "End practice")) : h("span"),
      runMenuEl()),
    h("h1", { className: "visually-hidden", tabindex: -1 }, "Run the event"),
    leaveRun ? h("div", { className: "c-msg warn", role: "alert" }, "A round is running. The clock keeps going while you're away. ",
      h("button", { className: "c-link", onclick: () => go("home") }, "Leave anyway"), " \u00b7 ",
      h("button", { className: "c-link", onclick: () => { leaveRun = false; render(); } }, "Stay")) : null,
    busy ? h("div", { className: "c-card c-now" }, h("p", { className: "c-round" }, h("span", { className: "spinner" }), " Working out who moves…")) : over ? null : roundCard(p),
    runProblem ? h("div", { className: "c-msg error", role: "alert" }, runProblem) : null,
    runNote ? h("div", { className: "c-msg ok" }, runNote) : null,
    current || busy ? null : h("div", { className: "c-msg warn c-row spread" }, "The schedule is out of date.",
      h("button", { className: "c-button primary", onclick: () => applyChange(() => "") }, "Update it")),
    current && !busy && !over ? tellList(p) : null,
    changeOpen && !over && !busy ? changeSheet(p) : null,
    over ? h("div", { className: "c-card c-wrap-moment" }, h("span", { className: "c-wrap-mark", "aria-hidden": "true" }, icon("check")),
      h("p", { className: "c-round" }, "That's a wrap."),
      h("p", { className: "c-lead" }, `${p.assignments.length} conversations happened tonight. Thank your alumni and your fams.`),
      h("button", { className: "c-button primary big wide", onclick: () => go("wrap") }, "Save for next year")) : null,
    busy ? null : whereList(p),
    !changeOpen && !over && !busy ? changeSheet(p) : null,
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
  const start = () => { startRound(s, r, nowMinutes()); s.night = { ...s.night, startedAt: { ...(s.night.startedAt ?? {}), [String(r)]: Date.now() } }; logChange(s, ctx.now(), `Round ${r} started.`); runNote = ""; ctx.persist(); render(); };
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
    st.phase === "during" && st.minutesLeft !== null ? h("div", {},
      timer(s.roundMinutes, secondsLeft(s, r, st.minutesLeft)),
      startedAt !== null ? h("p", { className: "c-help center-text" }, `Ends at ${shown(startedAt + s.roundMinutes)}`) : null)
      : st.phase === "before" ? h("p", { className: "c-help" }, `${p.rounds} rounds of ${s.roundMinutes} minutes. Tap start when everyone is seated.`)
      : st.phase === "moving" ? h("p", { className: "c-help" }, "Alumni go to the table on their card. Start the round when they are seated.") : null,
    action,
    st.phase === "during" ? h("p", { className: "c-next" }, r < p.rounds ? `Next: round ${r + 1}. Alumni go to the table on their card.` : "Last round. Then thank everyone.") : null,
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
      h("button", { className: "c-button wide quiet", "data-k": "someone-changed", onclick: () => { changeOpen = true; change = null; runProblem = ""; runNote = ""; render(); (document.querySelector(".c-change h2") as HTMLElement | null)?.focus(); } }, icon("bell"), "Something came up"));
  }
  const choices: [NonNullable<typeof change>, string][] = [
    ["left", "An alum left or didn't come"], ["arrived", "An alum arrived late, or someone new came"],
    ["table", "A fam is sitting at a different table"], ["wrong", "An alum is at the wrong table"], ["famLeft", "A whole fam left"],
  ];
  let form: HTMLElement | null = null;
  const run = (label: string, f: () => string) => h("button", { className: "c-button primary big wide", onclick: () => applyChange(f) }, label);
  if (change === "left") {
    const here = s.hosts.filter((r) => named(r) && !(r.host_id in s.cancelHosts));
    const who = h("select", { "aria-label": "Alum who left" }, h("option", { value: "" }, "Who?"), here.flatMap((r) => {
      const people = peopleIn(whoAt(r));
      return people.length > 1 ? people.map((name, i) => h("option", { value: `${r.host_id}|${i}` }, name)) : [h("option", { value: r.host_id }, whoAt(r))];
    })) as HTMLSelectElement;
    const from = roundPick("Misses from round", firstOpen);
    form = h("div", { className: "c-form" }, who, from, run("Work out who moves", () => {
      if (!who.value) return "Choose who left.";
      if (who.value.includes("|")) {
        // One of a pair leaves: their partner keeps the table, so nobody moves.
        const [id, i] = who.value.split("|");
        const r = s.hosts.find((x) => x.host_id === id)!;
        const people = peopleIn(whoAt(r));
        const stay = people.filter((_, j) => j !== Number(i));
        r.host_name = stay.join(" & ");
        logChange(s, ctx.now(), `${people[Number(i)]} left. ${r.host_name} keeps hosting the table.`);
        return "";
      }
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
      h("label", { for: "c-notes", className: "c-label" }, "What would you change next year? (optional)"), notes,
      h("p", { className: "c-help" }, "No student names here, please.")),
    h("p", { className: "c-help" }, "Save for next year makes one file with your alumni, fams, and notes. No student names, no schedules."),
    names ? h("p", { className: "c-help" }, "Your office may ask you not to keep student names. ",
      h("button", { className: "c-link", onclick: () => {
        if (!sure) { sure = true; render(); return; }
        sure = false; ctx.removeStudentNames(); say("ok", "Student names deleted from this event."); render();
      } }, sure ? "Yes, delete them now" : "Delete student names from this event")) : null);
}

/** For tests and the app shell. */
export function guidedStep(n: number): void { go((["setup", "schedule", "print", "run", "wrap"] as Place[])[n] ?? "home"); }
export const guidedFieldsCount = () => FIELDS.length;
