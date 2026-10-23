// The Rotation Optimizer page. Everything runs in the browser: the tables,
// the solver, and the printouts. The event is saved in this browser as you
// work, and the event file is the copy to keep.

import highsLoader from "highs";
import practiceFams from "../../templates/practice_fams.csv";
import practiceHosts from "../../templates/practice_hosts.csv";
import { download, h, openPage, readFile, replace, rich } from "./dom";
import {
  EventState, FAM_COLUMNS, famLocations, stepFreeFams, HOST_COLUMNS, NearMiss, RULE_COLUMNS, applySpelling, beforeTheNight, checkInputs, fingerprint,
  handoffEvent, hasStarted, isCurrent, loadEvent, maxRounds, nearMisses, newEvent, normalizeState, normalizeTable,
  removedRows, restoreRemovedRows, roundsLimitText, saveEvent, solveEvent,
} from "./event";
import {
  hostCardsHtml, hostViewRows, runSheetHtml, scheduleCsv, seatingChartHtml, tableNumbers, tableTentsHtml,
} from "./export";
import {
  EventPlan, InfeasibleProblemError, describeReprint, hostLabel, famName, openSlots, planChanges, provenOptimal,
  reprintList, slotText, weakCount,
} from "./planning";
import { explainPairing, sharedPairings } from "./explain";
import { FIELDS, formsScript } from "./forms";
import { changeSlipsHtml, movesBetween } from "./moves";
import {
  addLateHost, cancelFam, cancelHost, currentRound, finishRound, joinLate, logChange, moveFamTable, notArrived, openTables, recordActual,
  roomTables, setupMissing, toggleMoved, toggleSetup, toggleTold, transitions, whereIs,
} from "./night";
import { GuidedCtx, renderGuided } from "./guided";
import { looksLikeHeader, parsePasted } from "./paste";
import {
  backupPacketHtml, coordinatorGuideHtml, hostBadgesHtml, mcCueCardHtml, planSummaryHtml, privacyNoteHtml, roleCardsHtml, runnerSheetsHtml,
  setupSheetHtml,
} from "./printables";
import { encodeSnapshot, qrSvg, snapshot as snapshotFor } from "./share";
import { endRound, leftText, nowMinutes, shown, startRound, status, toMinutes } from "./timing";
import { csvRecords, sha256Hex } from "./py";
import {
  CleanRow, FILE_COLUMNS, FRIENDLY, Kind, RULE_KINDS, SheetError, columnReport, dropExampleRows, groupStudentRows,
  matchColumns, renameColumns, templateCsv,
} from "./sheets";
import type { HighsLike } from "./solver";
import { zipFiles } from "./zip";

declare const __VERSION__: string;
declare const __RELEASE_DATE__: string;

const STORE_KEY = "rotation-optimizer:event";
const SCORE_LINE = "How scores work: a pairing scores from 0 to 100, the share of all the tags the host and fam list that they have in common. Fam size does not count. The best schedule has the highest total.";

// ----------------------------------------------------------------------
// State.
// ----------------------------------------------------------------------

interface Pending { kind: Kind; name: string; rows: Record<string, string>[]; columns: string[]; mapping: Record<string, string> }

interface Ui {
  savedHash: string;
  savedAt: string;
  notes: Record<string, [string, string]>; // slot: [kind, text]
  pending: Partial<Record<Kind, Pending>>;
  undo: { kind: Kind; rows: CleanRow[]; name: string } | null;
  confirmStart: "example" | "blank" | null;
  confirmCancel: { kind: "host" | "fam"; id: string; name: string; first: number } | null;
  solveError: { fp: string; text: string; where: "tables" | "night" } | null;
  tab: number;
  unfinish: number | null;
  restored: string;
  solving: boolean;
  explain: { round: number; famId: string } | null;
  pinned: { rule: CleanRow; text: string } | null;
  confirmNames: boolean;
  runners: number;
}

let ev: EventState;
// Practice mode: the real event waits here while the coordinator tries a
// rehearsal on a copy. Only the real event is ever saved in the browser.
let practiceOriginal: EventState | null = null;
let highs: HighsLike | null = null;
const ui: Ui = {
  savedHash: "", savedAt: "", notes: {}, pending: {}, undo: null, confirmStart: null, confirmCancel: null,
  solveError: null, tab: 1, unfinish: null, restored: "", solving: false, explain: null, pinned: null, confirmNames: false, runners: 2,
};

function practiceEvent(): EventState {
  const rows = (text: string, kind: Kind) => {
    const { rows: r, columns } = csvRecords(text);
    return renameColumns(r, matchColumns(columns, kind));
  };
  const s = newEvent({ title: "Example dinner", hosts: rows(practiceHosts, "hosts"), fams: rows(practiceFams, "fams") });
  normalizeState(s);
  return s;
}

const fileHash = (s: EventState) => sha256Hex(saveEvent({ ...s, title: s.title }));

function now(): string {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

let storeTimer = 0;
function store(): void {
  clearTimeout(storeTimer);
  storeTimer = 0;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ event: saveEvent(practiceOriginal ?? ev), savedHash: ui.savedHash, savedAt: ui.savedAt, at: now() }));
  } catch { /* private window or storage full: the event file is still the copy to keep */ }
}
function persist(): void {
  clearTimeout(storeTimer);
  storeTimer = window.setTimeout(store, 250);
}
// Recent versions, so a wrong click or a bad re-plan can be taken back
// even without a saved file. Kept in this browser only, newest first.
const VERSIONS_KEY = "rotation-optimizer:versions";
interface Version { at: string; why: string; event: string }
function versions(): Version[] {
  try { return JSON.parse(localStorage.getItem(VERSIONS_KEY) ?? "[]"); } catch { return []; }
}
function snapshot(why: string): void {
  if (practiceOriginal) return;
  const list = [{ at: `${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}, ${now()}`, why, event: saveEvent(ev) }, ...versions()].slice(0, 12);
  for (let n = list.length; n > 0; n--) {
    try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(list.slice(0, n))); return; } catch { /* storage full: keep fewer */ }
  }
}

// Write any change still waiting before the page goes away.
window.addEventListener("pagehide", () => { if (storeTimer) store(); });

/** Re-render without moving the page: the window keeps its scroll position. */
function steady(render: () => void): void {
  const y = window.scrollY;
  const main = document.getElementById("main");
  if (main) main.style.minHeight = `${main.offsetHeight}px`;
  render();
  if (main) main.style.minHeight = "";
  if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
}

function note(slot: string, kind: "ok" | "info" | "warn" | "error", text: string): void {
  ui.notes = { [slot]: [kind, text] };
}

function noteEl(slot: string): HTMLElement | null {
  const n = ui.notes[slot];
  return n ? h("div", { className: `msg ${n[0]}`, role: n[0] === "error" ? "alert" : "status" }, n[1]) : null;
}

/** Re-render everything except the table editors, so typing is never interrupted. */
function refresh(opts: { tables?: boolean; scrollTo?: string } = {}): void {
  persist();
  if (!document.getElementById("sidebar")) { ui.notes = {}; return; } // the guided planner draws itself
  steady(() => {
    renderTopNote();
    renderSidebar();
    if (opts.tables) renderTables();
    renderUploads();
    renderFamTotals();
    renderChecks();
    renderSchedule();
    renderChecklist();
    renderNight();
  });
  if (opts.scrollTo) {
    const target = document.getElementById(opts.scrollTo);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }
  ui.notes = {};
}

function startOver(state: EventState, message: string): void {
  ev = state;
  ui.savedHash = fileHash(ev);
  ui.savedAt = "";
  ui.pending = {};
  ui.undo = null;
  ui.confirmStart = null;
  ui.confirmCancel = null;
  ui.solveError = null;
  ui.tab = 1;
  ui.restored = "";
  note("top", "ok", message);
  refresh({ tables: true, scrollTo: "top" });
}

// ----------------------------------------------------------------------
// Sidebar.
// ----------------------------------------------------------------------

function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  return h("label", { className: "field" }, h("span", { className: "label" }, label), input, help ? h("span", { className: "help" }, help) : null);
}

function renderSidebar(): void {
  const side = document.getElementById("sidebar")!;
  const saved = fileHash(ev) === ui.savedHash;
  const top = ev.hosts.length || ev.fams.length ? maxRounds(ev) : null;
  const title = h("input", { type: "text", value: ev.title, "aria-label": "Event name" }) as HTMLInputElement;
  title.addEventListener("input", () => { ev.title = title.value; persist(); renderSaveStatus(); });
  const rounds = h("input", { type: "number", min: 1, step: 1, value: ev.rounds, "aria-label": "Rounds" }) as HTMLInputElement;
  rounds.addEventListener("change", () => {
    let n = Math.max(1, Math.floor(Number(rounds.value) || 1));
    if (top !== null && n > top) {
      n = top;
      ev.rounds = n;
      note("rounds", "warn", roundsLimitText(ev) + ` Rounds is set to ${top}.`);
    } else ev.rounds = n;
    ev.finished = Math.min(ev.finished, ev.rounds - 1);
    refresh({ tables: true });
  });
  const weak = h("input", { type: "checkbox", checked: ev.oneWeakRound }) as HTMLInputElement;
  weak.addEventListener("change", () => { ev.oneWeakRound = weak.checked; refresh(); });
  const start = h("input", { type: "text", value: ev.startTime, placeholder: "6:30 PM", "aria-label": "Doors open at" }) as HTMLInputElement;
  start.addEventListener("input", () => { ev.startTime = start.value; persist(); });
  const minutes = h("input", { type: "number", min: 5, max: 120, step: 5, value: ev.roundMinutes, "aria-label": "Minutes per round" }) as HTMLInputElement;
  minutes.addEventListener("change", () => { ev.roundMinutes = Math.min(120, Math.max(5, Number(minutes.value) || 20)); persist(); });

  const openFile = h("input", { type: "file", accept: ".json,application/json", className: "visually-hidden", id: "open-event" }) as HTMLInputElement;
  openFile.addEventListener("change", async () => {
    const f = openFile.files?.[0];
    openFile.value = "";
    if (!f) return;
    try {
      const state = loadEvent(await readFile(f));
      if (!blank()) snapshot(`before opening ${f.name}`);
      startOver(state, `Opened ${f.name}.`);
    } catch (err) {
      note("file", "error", err instanceof SheetError ? err.problems[0] : "That file could not be opened.");
      renderSidebar();
    }
  });
  const uploads = (["hosts", "fams"] as Kind[]).map((kind) => {
    const input = h("input", { type: "file", accept: ".csv,text/csv", className: "visually-hidden", id: `up-${kind}` }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      input.value = "";
      if (!f) return;
      const { rows, columns } = csvRecords(await readFile(f));
      ui.pending[kind] = { kind, name: f.name, rows, columns, mapping: matchColumns(columns, kind) };
      refresh({ scrollTo: `upload-${kind}` });
    });
    return h("div", {},
      input,
      h("label", { htmlFor: `up-${kind}`, for: `up-${kind}`, className: "button wide" }, kind === "hosts" ? "Upload host tables" : "Upload fams"),
      ui.pending[kind] ? h("p", { className: "help warn-text" }, "Waiting for you to confirm on the page.") : null);
  });

  replace(side,
    h("button", { className: "button wide primary", onclick: () => setUi("guided") }, "Back to the guided planner"),
    h("h2", {}, "Event"),
    field("Event name", title),
    field("Rounds", rounds, "How many times the hosts move. Each fam meets a different host every round."),
    noteEl("rounds"),
    h("label", { className: "check" }, weak, " No fam gets more than one weak round"),
    h("p", { className: "help" }, "A weak round is a host who shares none of the fam's interests, or no host at all."),
    h("details", {}, h("summary", {}, "Times for the run sheet"),
      field("Doors open at", start, "Leave blank to write the times on the run sheet by hand."),
      field("Minutes per round", minutes)),

    h("h2", {}, "Save your work"),
    h("button", { className: "button wide primary", onclick: saveFile }, "Save event file (keep this to continue later)"),
    h("p", { className: "help", id: "save-status" }),
    openFile,
    h("label", { for: "open-event", className: "button wide" }, "Open a saved event file"),
    noteEl("file"),
    notesField(),
    versionsBox(),
    h("button", { className: "button wide", onclick: handOff }, "Hand off to next year"),
    h("p", { className: "help" }, "A folder for next year's coordinator: the event file without student names, cancellations, or schedules, plus a note on how to open it, your notes, and what changed on the night."),

    h("details", {}, h("summary", {}, "Working without internet"),
      h("p", { className: "help", id: "offline-status" }, offlineText()),
      h("button", { className: "button wide", onclick: downloadOfflineCopy }, "Download an offline copy of this app"),
      h("p", { className: "help" }, "One file (about 5 MB) that opens in any browser with no internet, even if this website goes away. Keep it with the event file.")),

    h("h2", {}, "Print for your team"),
    h("div", { className: "stack" },
      h("button", { className: "button wide", onclick: () => openPage(coordinatorGuideHtml(ev.title)) }, "Coordinator guide (2 pages)"),
      h("button", { className: "button wide", onclick: () => openPage(roleCardsHtml(ev.title)) }, "Volunteer role cards"),
      h("button", { className: "button wide", onclick: () => openPage(privacyNoteHtml()) }, "Privacy note for IT or a supervisor")),

    h("h2", {}, "Rehearse"),
    practiceOriginal
      ? h("button", { className: "button wide primary", onclick: endPractice }, "End practice and go back to my event")
      : h("button", { className: "button wide", disabled: !ev.plan, onclick: startPractice }, "Practice the night"),
    h("p", { className: "help" }, ev.plan || practiceOriginal ? "Try cancellations, late alumni, and re-plans on a copy. Nothing you do in practice is kept." : "Make a schedule first, then practice the night on a copy."),

    h("h2", {}, "Student names"),
    ui.confirmNames ? h("div", { className: "msg warn" }, "Remove every student name from this event? The find-your-table page needs them.",
      h("div", { className: "row" },
        h("button", { className: "button primary", onclick: removeStudentNames }, "Remove names"),
        h("button", { className: "button", onclick: () => { ui.confirmNames = false; renderSidebar(); } }, "Keep them")))
      : h("button", { className: "button wide", disabled: !ev.fams.some((r) => (r.students ?? "").trim()), onclick: () => { ui.confirmNames = true; renderSidebar(); } }, "Remove student names"),
    h("p", { className: "help" }, "For after the event, or before sharing the file. Alumni names and everything else stay."),

    h("h2", {}, "Start"),
    h("button", { className: "button wide", onclick: () => askStart("example") }, "Load the example dinner"),
    h("button", { className: "button wide", onclick: () => askStart("blank") }, "Start a blank event"),
    ui.confirmStart ? h("div", { className: "msg warn" },
      "You have unsaved changes. Replace anyway?",
      h("div", { className: "row" },
        h("button", { className: "button primary", onclick: () => replaceEvent(ui.confirmStart!) }, "Replace"),
        h("button", { className: "button", onclick: () => { ui.confirmStart = null; renderSidebar(); } }, "Keep mine"))) : null,
    h("button", { className: "button wide", onclick: () => download("example.rotation.json", saveEvent(practiceEvent()), "application/json") }, "Download the example event"),

    h("h2", {}, "Start from a spreadsheet"),
    h("p", { className: "help" },
      "Fill in a template in Google Sheets or Excel, save it as CSV (in Google Sheets: File, Download, Comma-separated values), and upload it here. " +
      "A Google Forms export works too: you pick which column holds what. Tags and interests are keywords separated by commas or semicolons. " +
      "Fams can be one row per fam, or one row per student with the fam name on each row."),
    h("details", { className: "forms" }, h("summary", {}, "Collect sign-ups with Google Forms"),
      h("p", { className: "help" }, "Two ready-made forms, one for alumni and one for students, with the same list of fields to tick, so the answers match exactly. Their answers upload here with no column matching."),
      h("ol", { className: "help steps" },
        h("li", {}, "Click Copy the script."),
        h("li", {}, "Go to script.google.com, click New project, delete what is there, paste, and click Run. Allow access when Google asks."),
        h("li", {}, "The two form links appear in the Execution log. Send them out."),
        h("li", {}, "When answers are in, open each form, Responses, the three dots, Download responses (.csv), and upload the file below.")),
      h("div", { className: "row" },
        h("button", { className: "button primary", onclick: copyFormsScript }, "Copy the script"),
        h("button", { className: "button", onclick: () => download("make_forms.gs", formsScript(ev.title), "text/plain") }, "Download it")),
      noteEl("forms"),
      h("p", { className: "help" }, `The fields: ${FIELDS.join(", ")}. Edit the list in the script before you run it if your event needs others.`)),
    h("div", { className: "row" },
      h("button", { className: "button", onclick: () => download("hosts_template.csv", templateCsv("hosts"), "text/csv") }, "Hosts template"),
      h("button", { className: "button", onclick: () => download("fams_template.csv", templateCsv("fams"), "text/csv") }, "Fams template")),
    uploads,
  );
  renderSaveStatus(saved);
}

function versionsBox(): HTMLElement | null {
  const list = versions();
  if (!list.length) return null;
  return h("details", {}, h("summary", {}, `Earlier versions in this browser (${list.length})`),
    h("p", { className: "help" }, "Saved automatically before big steps. Restoring one keeps your current version in this list too."),
    h("ul", { className: "versions" }, list.map((v, i) => h("li", {}, h("span", {}, `${v.at}: ${v.why}`),
      h("button", { className: "button small", onclick: () => {
        snapshot("before restoring an earlier version");
        try { startOver(loadEvent(list[i].event), `Restored the version from ${v.at}.`); } catch { note("file", "error", "That version could not be restored."); renderSidebar(); }
      } }, "Restore")))));
}

function offlineText(): string {
  if (location.protocol === "file:") return "This is the offline copy: it works with no internet.";
  return navigator.serviceWorker?.controller
    ? "This page is saved on this device, so it opens and plans with no internet."
    : "After this page finishes loading once, it is saved on this device and works with no internet.";
}

async function copyFormsScript(): Promise<void> {
  try {
    await navigator.clipboard.writeText(formsScript(ev.title));
    note("forms", "ok", "Copied. Now paste it at script.google.com.");
  } catch {
    download("make_forms.gs", formsScript(ev.title), "text/plain");
    note("forms", "info", "Copying is blocked here, so the script was downloaded instead. Open it and copy everything.");
  }
  renderSidebar();
  const d = document.querySelector<HTMLDetailsElement>("details.forms");
  if (d) d.open = true;
}

function removeStudentNames(): void {
  snapshot("before removing student names");
  ev.fams = ev.fams.map((r) => ({ ...r, students: "" }));
  ui.confirmNames = false;
  note("top", "ok", "Student names removed. Re-plan to update the printouts.");
  refresh({ tables: true, scrollTo: "top" });
}

function startPractice(): void {
  practiceOriginal = ev;
  ev = loadEvent(saveEvent(ev));
  setNightMode(true);
}

function endPractice(): void {
  if (!practiceOriginal) return;
  ev = practiceOriginal;
  practiceOriginal = null;
  ui.solveError = null;
  night.confirm = null;
  setNightMode(false);
  note("top", "ok", "Practice ended. Your event is exactly as it was.");
  refresh({ scrollTo: "top" });
  if (uiMode === "guided") renderGuided(guidedCtx);
}

function practiceBanner(): HTMLElement | null {
  return practiceOriginal ? h("div", { className: "msg warn row spread practice" },
    h("span", {}, h("strong", {}, "Practice: "), "nothing here is kept. Try a cancellation, a late alum, and a re-plan."),
    h("button", { className: "button", onclick: endPractice }, "End practice")) : null;
}

function notesField(): HTMLElement {
  const box = h("textarea", { rows: 3, "aria-label": "Notes for next year", placeholder: "For example: Table 7 is by the kitchen and loud." }) as HTMLTextAreaElement;
  box.value = ev.notes;
  box.addEventListener("input", () => { ev.notes = box.value; persist(); renderSaveStatus(); });
  return field("Notes for next year", box, "Kept in the event file and in the hand-off. No student names here, please.");
}

function renderSaveStatus(saved = fileHash(ev) === ui.savedHash): void {
  const el = document.getElementById("save-status");
  if (!el) return;
  replace(el, saved
    ? ui.savedAt ? `Saved at ${ui.savedAt}.` : "No changes since this event was opened."
    : h("span", {}, h("span", { className: "warn-text" }, "Not saved to a file yet. "), "Your work is kept in this browser, but save the event file to keep a copy you can move or share."));
}

function saveFile(): void {
  download(fileName("event file", "rotation.json"), saveEvent(ev), "application/json");
  ui.savedHash = fileHash(ev);
  ui.savedAt = now();
  persist();
  renderSaveStatus();
  renderChecklist();
}

function handOff(): void {
  const base = cleanName(ev.title || "Event");
  const readme = `${base}: hand-off for next year's coordinator

What this is
This folder holds the event file for ${base}, made with Rotation Optimizer, a free
tool that plans which alumni host table visits which fam in each round of a
rotation dinner, prints the seating chart, host cards, table tents, and a run
sheet, and re-plans when someone cancels.

How to open it
1. Go to https://chrishoangle.github.io/rotation-optimizer/app/
2. Choose Open a saved event, and pick "${base} handoff.rotation.json"
   from this folder.
3. Check the alumni and fams for your year, then click Make the schedule.
   The steps at the top of the page walk you through the rest.

What was kept
The host tables, alum names, and tags; the fams, table numbers, sizes, and
interests; the pairing rules; and the settings.

What was removed from the event file
Student names, the night's cancellations, check-in, finished rounds, and
every schedule.
${ev.notes.trim() ? `\nNotes from this year's coordinator\n${ev.notes.trim()}\n` : ""}${ev.nightLog.length ? `\nWhat happened on the night\n${ev.nightLog.map((e) => `${e.at}  ${e.text}`).join("\n")}\n` : ""}`;
  const zip = zipFiles([
    { name: `${base} handoff/README.txt`, text: readme },
    { name: `${base} handoff/${base} handoff.rotation.json`, text: saveEvent(handoffEvent(ev)) },
  ]);
  download(`${base} handoff.zip`, zip, "application/zip");
}

const cleanName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Event";

function fileName(what: string, ext: string): string {
  const stamp = now().replace(":", ".").replace(/\s/g, "").toLowerCase();
  return `${cleanName(ev.title)} ${what} ${stamp}.${ext}`;
}

function askStart(kind: "example" | "blank"): void {
  if (fileHash(ev) === ui.savedHash) replaceEvent(kind);
  else { ui.confirmStart = kind; renderSidebar(); }
}

function replaceEvent(kind: "example" | "blank"): void {
  if (!blank()) snapshot(kind === "example" ? "before loading the example" : "before starting a blank event");
  if (kind === "example") startOver(practiceEvent(), "Loaded the example dinner: 10 host tables and 10 fams. Click Find the best schedule.");
  else startOver(newEvent({ title: "New event" }), "Started a blank event. Add host tables and fams below, or upload them.");
}

// ----------------------------------------------------------------------
// Upload previews.
// ----------------------------------------------------------------------

const NOT_IN_FILE = "(not in this file)";

function prepared(p: Pending): [Record<string, string>[], string[], string[]] {
  const [problems, notices, mapping] = columnReport(p.columns, p.kind, p.mapping);
  let rows = renameColumns(p.rows, mapping).filter((r) => Object.values(r).some((v) => (v || "").trim()));
  let skipped: number;
  [rows, skipped] = dropExampleRows(rows);
  if (skipped) notices.push(`Skipped ${skipped} example row${skipped > 1 ? "s" : ""} from the template.`);
  if (p.kind === "fams") {
    let grouped: number;
    [rows, grouped] = groupStudentRows(rows);
    if (grouped) notices.push(`Each row looked like one student, so ${grouped} students were grouped into ${rows.length} fams by fam name. Size is the number of responses; edit it in the fams table if some students did not fill in the form.`);
  }
  return [rows, problems, notices];
}

function renderUploads(): void {
  for (const kind of ["hosts", "fams"] as Kind[]) {
    const box = document.getElementById(`upload-${kind}`)!;
    const p = ui.pending[kind];
    const noun = kind === "hosts" ? "host tables" : "fams";
    if (!p) {
      replace(box, noteEl(`upload-${kind}`),
        ui.undo && ui.undo.kind === kind ? h("button", { className: "button", onclick: () => undoUpload(kind) }, "Undo upload") : null);
      continue;
    }
    const [rows, problems, notices] = prepared(p);
    const current = (kind === "hosts" ? ev.hosts : ev.fams).length;
    const selects = FILE_COLUMNS[kind].map((ours) => {
      const sel = h("select", { "aria-label": FRIENDLY[ours] }, [NOT_IN_FILE, ...p.columns].map((c) =>
        h("option", { value: c, selected: (p.mapping[ours] ?? NOT_IN_FILE) === c }, c))) as HTMLSelectElement;
      sel.addEventListener("change", () => {
        if (sel.value === NOT_IN_FILE) delete p.mapping[ours];
        else p.mapping[ours] = sel.value;
        renderUploads();
      });
      return field(FRIENDLY[ours], sel);
    });
    replace(box, h("div", { className: "panel" },
      h("p", {}, h("strong", {}, `Uploaded ${noun}: ${p.name}`), `, ${p.rows.length} rows. Check which column holds what.`),
      h("p", { className: "help" }, "Columns you do not choose are left out, so a form's email or phone column is never kept."),
      h("div", { className: "mapping" }, selects),
      problems.map((x) => h("div", { className: "msg error" }, x)),
      notices.map((x) => h("div", { className: "msg info" }, x)),
      rows.length && !problems.length ? previewTable(rows.slice(0, 5)) : null,
      h("div", { className: "row" },
        h("button", { className: "button primary", disabled: !!problems.length || !rows.length, onclick: () => confirmUpload(kind, rows) },
          `Replace ${current} ${noun} with these ${rows.length}`),
        h("button", { className: "button", onclick: () => { delete ui.pending[kind]; refresh(); } }, "Cancel")),
    ));
  }
}

function previewTable(rows: Record<string, string>[]): HTMLElement {
  const cols = Object.keys(rows[0]);
  return h("div", { className: "scroll" }, h("table", { className: "plain" },
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, FRIENDLY[c] ?? c)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => h("td", {}, r[c])))))));
}

function confirmUpload(kind: Kind, rows: Record<string, string>[]): void {
  const p = ui.pending[kind]!;
  ui.undo = { kind, rows: kind === "hosts" ? ev.hosts : ev.fams, name: p.name };
  if (kind === "hosts") ev.hosts = normalizeTable(rows, HOST_COLUMNS, "host_id", "h");
  else ev.fams = normalizeTable(rows, FAM_COLUMNS, "fam_id", "fam_");
  delete ui.pending[kind];
  note(`upload-${kind}`, "ok", `Replaced the ${kind === "hosts" ? "host tables" : "fams"} with ${rows.length} rows from ${p.name}.`);
  refresh({ tables: true, scrollTo: `upload-${kind}` });
}

function undoUpload(kind: Kind): void {
  if (!ui.undo) return;
  if (kind === "hosts") ev.hosts = ui.undo.rows; else ev.fams = ui.undo.rows;
  ui.undo = null;
  note(`upload-${kind}`, "ok", "Upload undone. Your previous table is back.");
  refresh({ tables: true });
}

// ----------------------------------------------------------------------
// Table editors: plain inputs, saved as you type.
// ----------------------------------------------------------------------

interface Column { key: string; label: string; width: string; help?: string; kind?: "rule" | "host" | "fam" }

const HOST_TABLE: Column[] = [
  { key: "table_label", label: "Host table name", width: "26%" },
  { key: "host_name", label: "Alum's name", width: "20%", help: "Optional. Printed on host cards only." },
  { key: "tags", label: "Tags", width: "54%" },
];
const FAM_TABLE: Column[] = [
  { key: "table_number", label: "Table #", width: "7%", help: "The number on the table in the room." },
  { key: "fam_label", label: "Fam name", width: "19%" },
  { key: "size", label: "Size", width: "6%", help: "How many students sit at this fam." },
  { key: "interests", label: "Interests", width: "24%" },
  { key: "students", label: "Students", width: "22%" },
  { key: "location", label: "Location", width: "13%", help: "Where the table is in the room, for example by the stage. Printed on host cards." },
  { key: "step_free", label: "Step-free", width: "9%", help: "yes if the table can be reached without steps." },
];
const RULE_TABLE: Column[] = [
  { key: "rule", label: "Rule", width: "24%", kind: "rule" },
  { key: "host_table", label: "Host table", width: "30%", kind: "host" },
  { key: "fam", label: "Fam", width: "30%", kind: "fam" },
  { key: "rounds", label: "Rounds", width: "16%", help: "For example 1, or 1, 2" },
];

function nextId(rows: CleanRow[], col: string, prefix: string): string {
  const used = new Set(rows.map((r) => r[col]));
  let n = 1;
  while (used.has(`${prefix}${String(n).padStart(2, "0")}`)) n++;
  return `${prefix}${String(n).padStart(2, "0")}`;
}

function tableEditor(name: "hosts" | "fams" | "rules", cols: Column[]): HTMLElement {
  const rows = () => (name === "hosts" ? ev.hosts : name === "fams" ? ev.fams : ev.rules);
  const blankRow = (): CleanRow => {
    const r: CleanRow = Object.fromEntries((name === "hosts" ? HOST_COLUMNS : name === "fams" ? FAM_COLUMNS : RULE_COLUMNS).map((c) => [c, ""]));
    if (name === "hosts") r.host_id = nextId(ev.hosts, "host_id", "h");
    if (name === "fams") r.fam_id = nextId(ev.fams, "fam_id", "fam_");
    return r;
  };
  const body = h("tbody") as HTMLTableSectionElement;
  const changed = () => {
    if (name !== "rules") renderRuleOptions();
    refresh();
  };
  const showDelete = () => {
    [...body.rows].forEach((tr, i) => {
      const b = tr.querySelector("button.icon") as HTMLButtonElement | null;
      if (b) b.hidden = i >= rows().length;
    });
  };
  // row is null for the empty last row; typing there turns it into a real row.
  const rowFor = (start: CleanRow | null): HTMLTableRowElement => {
    let row = start;
    const tr = h("tr", { className: row ? "" : "new" }) as HTMLTableRowElement;
    const ensure = (): CleanRow => {
      if (!row) {
        row = blankRow();
        rows().push(row);
        tr.classList.remove("new");
        body.appendChild(rowFor(null));
        showDelete();
      }
      return row;
    };
    cols.forEach((col, cIdx) => {
      const value = row ? row[col.key] ?? "" : "";
      const label = `${col.label}, row ${body.rows.length + 1}`;
      let input: HTMLInputElement | HTMLSelectElement;
      if (col.kind) {
        input = h("select", { "aria-label": label, "data-col": col.key, "data-kind": col.kind }) as HTMLSelectElement;
        fillOptions(input, col.kind, value);
        input.addEventListener("change", () => { ensure()[col.key] = input.value; changed(); });
      } else {
        input = h("input", { type: "text", value, "aria-label": label, "data-col": col.key,
          spellcheck: col.key === "tags" || col.key === "interests" ? "true" : "false" }) as HTMLInputElement;
        input.addEventListener("input", () => { ensure()[col.key] = input.value; changed(); });
        if (col.key.endsWith("label")) input.addEventListener("change", renderRuleOptions);
        if (name !== "rules") {
          input.addEventListener("paste", (e) => {
            const text = (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
            const grid = parsePasted(text);
            if (!grid) return; // one plain value: let the browser paste it into this cell
            e.preventDefault();
            const at = [...body.rows].indexOf(tr);
            note("checks", "ok", pasteRows(name, grid, at, cIdx, blankRow));
            refresh({ tables: true });
          });
        }
      }
      input.addEventListener("keydown", (e) => {
        const k = e as KeyboardEvent;
        if (k.key !== "Enter" || k.shiftKey || input instanceof HTMLSelectElement) return;
        k.preventDefault();
        const i = [...body.rows].indexOf(tr);
        const next = body.rows[i + 1]?.cells[cIdx]?.querySelector("input,select") as HTMLElement | null;
        next?.focus();
        if (next instanceof HTMLInputElement) next.select();
      });
      tr.appendChild(h("td", {}, input));
    });
    const del = h("button", { className: "icon", title: "Delete this row", "aria-label": "Delete this row" }, "×") as HTMLButtonElement;
    del.addEventListener("click", () => {
      const i = [...body.rows].indexOf(tr);
      if (i < 0 || i >= rows().length) return;
      rows().splice(i, 1);
      tr.remove();
      showDelete();
      changed();
    });
    tr.appendChild(h("td", { className: "del" }, del));
    return tr;
  };
  rows().forEach((r) => body.appendChild(rowFor(r)));
  body.appendChild(rowFor(null));
  showDelete();
  return h("div", { className: "scroll" }, h("table", { className: "editor", "data-table": name },
    h("colgroup", {}, cols.map((c) => h("col", { style: `width:${c.width}` })), h("col", { style: "width:2.2rem" })),
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", { title: c.help ?? "" }, c.label)), h("th", {}, h("span", { className: "visually-hidden" }, "Delete")))),
    body));
}

/** Write pasted cells into a table from the given row and column, adding rows as needed. */
function pasteRows(name: "hosts" | "fams", grid: string[][], startRow: number, startCol: number, blankRow: () => CleanRow): string {
  const cols = (name === "hosts" ? HOST_TABLE : FAM_TABLE).map((c) => c.key);
  const list = name === "hosts" ? ev.hosts : ev.fams;
  // A header row from the sheet places each column by its name, in any order.
  const mapping = matchColumns(grid[0], name);
  const required = name === "hosts" ? "table_label" : "fam_label";
  const byHeader = looksLikeHeader(grid[0]) && required in mapping;
  const body = byHeader ? grid.slice(1) : grid;
  const place = (cells: string[]): [string, string][] => byHeader
    ? Object.entries(mapping).map(([ours, theirs]) => [ours, cells[grid[0].indexOf(theirs)] ?? ""])
    : cells.map((v, k) => [cols[startCol + k], v] as [string, string]).filter(([key]) => key !== undefined);
  const first = byHeader ? Math.min(startRow, list.length) : startRow;
  body.forEach((cells, k) => {
    const at = first + k;
    while (list.length <= at) list.push(blankRow());
    for (const [key, v] of place(cells)) list[at][key] = v;
  });
  const what = name === "hosts" ? "host table" : "fam";
  const n = body.length;
  return `Pasted ${n} ${what}${n !== 1 ? "s" : ""}` + (byHeader ? ", matching columns by the header row." : ".");
}

function fillOptions(sel: HTMLSelectElement, kind: "rule" | "host" | "fam", value: string): void {
  const opts = kind === "rule" ? Object.keys(RULE_KINDS)
    : kind === "host" ? ev.hosts.map((r) => r.table_label).filter((x) => x)
    : ev.fams.map((r) => r.fam_label).filter((x) => x);
  const all = value && !opts.includes(value) ? [...opts, value] : opts;
  replace(sel, h("option", { value: "" }, "Choose…"), all.map((o) => h("option", { value: o, selected: o === value }, o)));
}

function renderRuleOptions(): void {
  document.querySelectorAll<HTMLSelectElement>('table[data-table="rules"] select').forEach((sel) => {
    fillOptions(sel, sel.dataset.kind as "rule" | "host" | "fam", sel.value);
  });
}

function renderTables(): void {
  replace(document.getElementById("hosts-table")!, tableEditor("hosts", HOST_TABLE));
  replace(document.getElementById("fams-table")!, tableEditor("fams", FAM_TABLE));
  replace(document.getElementById("rules-table")!, tableEditor("rules", RULE_TABLE));
}

// ----------------------------------------------------------------------
// Checks and solving.
// ----------------------------------------------------------------------

function blank(): boolean {
  return !ev.hosts.some((r) => Object.entries(r).some(([k, v]) => k !== "host_id" && v.trim()))
    && !ev.fams.some((r) => Object.entries(r).some(([k, v]) => k !== "fam_id" && v.trim()));
}

function currentProblems(): string[] {
  const inputs = checkInputs(ev);
  const problems = [...inputs.problems];
  const err = ui.solveError;
  if (err && err.fp === fingerprint(ev)) { if (err.where === "tables") problems.push(err.text); }
  else ui.solveError = null;
  return problems;
}

function renderChecks(): void {
  const box = document.getElementById("checks")!;
  if (blank()) {
    replace(box, noteEl("checks"), h("div", { className: "msg info" }, "Add host tables and fams above, or upload them from the sidebar, then click Find the best schedule."));
    return;
  }
  const inputs = checkInputs(ev);
  const problems = currentProblems();
  const misses = nearMisses(ev.hosts, ev.fams);
  const gone = ev.finished > 0 ? removedRows(ev) : [];
  replace(box,
    noteEl("checks"),
    problems.length ? h("div", { className: "msg error", role: "alert" }, h("strong", {}, "Please fix these first:"), h("ul", {}, problems.map((p) => h("li", {}, p)))) : null,
    inputs.warnings.map((w) => h("div", { className: "msg warn" }, w)),
    misses.map((m) => h("div", { className: "msg info row spread" },
      `Did you mean the same thing by ${m.spellings.join(" / ")}? Only exact matches add to a score.`,
      h("button", { className: "button", onclick: () => fixSpelling(m) }, `Use '${m.suggestion}' everywhere`))),
    gone.length ? h("div", { className: "msg error row spread" },
      `You removed ${gone.join(", ")}, but rounds have already happened, so the schedule would no longer match what happened. Restore the rows, then use Cancel a host or Cancel a fam below.`,
      h("button", { className: "button", onclick: restoreRows }, "Restore removed rows")) : null,
  );
  const findBtn = document.getElementById("find") as HTMLButtonElement;
  findBtn.textContent = ev.plan ? "Re-plan with these tables" : "Find the best schedule";
  findBtn.disabled = ui.solving;
}

function renderFamTotals(): void {
  const el = document.getElementById("fam-totals");
  if (!el) return;
  const fams = ev.fams.filter((r) => (r.fam_label ?? "").trim());
  const size = (r: CleanRow) => Number(r.size) || (r.students ?? "").split(/[;\n]/).filter((x) => x.trim()).length;
  const sized = fams.map((r) => [r.fam_label, size(r)] as const).filter(([, n]) => n > 0);
  if (!sized.length) { replace(el); return; }
  const total = sized.reduce((t, [, n]) => t + n, 0);
  const big = sized.reduce((a, b) => (b[1] > a[1] ? b : a));
  const small = sized.reduce((a, b) => (b[1] < a[1] ? b : a));
  const missing = fams.length - sized.length;
  replace(el, `${total} students in ${sized.length} fam${sized.length !== 1 ? "s" : ""}` +
    (sized.length > 1 ? `. Largest: ${big[0]} (${big[1]}). Smallest: ${small[0]} (${small[1]}).` : ".") +
    (missing ? ` ${missing} fam${missing !== 1 ? "s have" : " has"} no size or student names yet.` : ""));
}

function fixSpelling(m: NearMiss): void {
  applySpelling(ev, m);
  refresh({ tables: true });
}

function restoreRows(): void {
  const back = restoreRemovedRows(ev);
  note("checks", "ok", `Restored ${back.join(", ")} in ` + (back.length === 1 ? "its original place." : "their original places."));
  refresh({ tables: true });
}

declare global { interface Window { HIGHS_WASM_BASE64?: string } }

function getHighs(): Promise<HighsLike> {
  if (highs) return Promise.resolve(highs);
  // The one-file offline copy carries the solver inside the page.
  const embedded = window.HIGHS_WASM_BASE64;
  const opts = embedded
    ? {
      instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
        WebAssembly.instantiate(Uint8Array.from(atob(embedded), (ch) => ch.charCodeAt(0)), imports).then((r) => done(r.instance, r.module));
        return {};
      },
    }
    : { locateFile: (f: string) => new URL(f, document.baseURI).href };
  return highsLoader(opts as never).then((x) => (highs = x as unknown as HighsLike));
}

/** The whole app as one HTML file that opens from a USB stick or a laptop with no internet. */
async function downloadOfflineCopy(): Promise<void> {
  try {
    const [js, css, wasm] = await Promise.all([
      fetch("app.js").then((r) => r.text()), fetch("style.css").then((r) => r.text()),
      fetch("highs.wasm").then((r) => r.arrayBuffer()),
    ]);
    const bytes = new Uint8Array(wasm);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rotation Optimizer (offline copy ${__VERSION__})</title>
<style>${css}</style></head><body>
<div id="app" aria-live="polite"><p class="loading">Loading the planner…</p></div>
<script>window.HIGHS_WASM_BASE64 = "${btoa(bin)}";</script>
<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>
`;
    download(`Rotation Optimizer ${__VERSION__} offline.html`, page, "text/html");
  } catch {
    note("file", "error", "The offline copy could not be made. Check your internet connection and try again.");
    renderSidebar();
  }
}

async function solve(keepPrinted: boolean, where: "tables" | "night"): Promise<boolean> {
  ui.solving = true;
  const status = document.getElementById(where === "tables" ? "find-status" : "replan-status");
  if (status) replace(status, h("span", { className: "spinner", "aria-hidden": "true" }), " Finding the best schedule…");
  await new Promise((r) => setTimeout(r, 30)); // let the page show the message first
  try {
    const solver = await getHighs();
    solveEvent(solver, ev, keepPrinted);
    ui.solveError = null;
    return true;
  } catch (err) {
    const text = err instanceof SheetError ? err.problems.join("; ") : err instanceof InfeasibleProblemError ? err.message : `Something went wrong: ${(err as Error).message}`;
    ui.solveError = { fp: fingerprint(ev), text, where };
    return false;
  } finally {
    ui.solving = false;
    if (status) replace(status);
  }
}

async function findSchedule(): Promise<void> {
  if (checkInputs(ev).problems.length || (ev.finished > 0 && removedRows(ev).length)) {
    refresh({ scrollTo: "checks" });
    return;
  }
  if (ev.plan) snapshot("before re-planning");
  const ok = await solve(hasStarted(ev) || ev.printed !== null, "tables");
  if (ok) note("schedule", "ok", "Schedule updated.");
  refresh({ tables: true, scrollTo: ok ? "schedule" : "checks" });
}

// ----------------------------------------------------------------------
// Schedule and printouts.
// ----------------------------------------------------------------------

function unmatchedShare(p: EventPlan): number {
  const ht = new Set(p.hosts.flatMap((x) => x.tags));
  const ft = new Set(p.fams.flatMap((x) => x.interests));
  const every = new Set([...ht, ...ft]);
  const both = [...every].filter((t) => ht.has(t) && ft.has(t)).length;
  return every.size ? (every.size - both) / every.size : 0;
}

function dataTable(rows: Record<string, unknown>[], names: Record<string, string>): HTMLElement {
  if (!rows.length) return h("p", {}, "Nothing to show.");
  const cols = Object.keys(rows[0]);
  return h("div", { className: "scroll" }, h("table", { className: "plain" },
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, names[c] ?? c[0].toUpperCase() + c.slice(1))))),
    h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => h("td", {}, String(r[c] ?? ""))))))));
}

const NAMES: Record<string, string> = { table: "Table", fam: "Fam", host_table: "Host table", score: "Score", host_name: "Alum" };

function renderSchedule(): void {
  const box = document.getElementById("schedule-body")!;
  const p = ev.plan;
  if (!p) { replace(box, noteEl("schedule"), h("div", { className: "msg info" }, "Click Find the best schedule above.")); return; }
  const problems = currentProblems();
  const current = isCurrent(ev) && !problems.length && !(ev.finished > 0 && removedRows(ev).length);
  const fairness = p.warnings.filter((w) => w.startsWith("Fairness check"));
  const notes = p.warnings.filter((w) => !w.startsWith("Fairness check"));
  const unmatched = unmatchedShare(p);
  const pairings = p.assignments.length + openSlots(p).length;
  ui.tab = Math.min(ui.tab, p.rounds + 1);
  const tabs = h("div", { className: "tabs", role: "tablist" },
    [...Array.from({ length: p.rounds }, (_, i) => `Round ${i + 1}`), "Host view"].map((label, i) =>
      h("button", { role: "tab", "aria-selected": ui.tab === i + 1 ? "true" : "false", className: "tab", onclick: () => { ui.tab = i + 1; steady(renderSchedule); } }, label)));
  const tabBody = ui.tab <= p.rounds ? roundTable(p, ui.tab, current) : dataTable(hostViewRows(p), NAMES);
  const printouts: [string, string, () => string, string][] = [
    ["Seating chart", "seating chart", () => seatingChartHtml(p, ev.title, null, true, "", famLocations(ev)), "One page per round for the room, then a find-your-table page."],
    ["Host cards", "host cards", () => hostCardsHtml(p, null, ev.title, "", famLocations(ev)), "Half a page per host: where to go each round and what to talk about."],
    ["Table tents", "table tents", () => tableTentsHtml(p), "A big table number to fold and stand on each fam's table."],
    ["Run sheet", "run sheet", () => runSheetHtml(p, ev.title, ev.startTime, ev.roundMinutes), "For you and the MC: a timeline for the night and check-in lists."],
  ];
  replace(box,
    noteEl("schedule"),
    current ? null : h("div", { className: "msg warn" },
      "Out of date: the tables, rules, settings, or cancellations changed since this schedule was made. " +
      (problems.length ? "Fix the problems above, then re-plan." : "Click Re-plan with these tables above, or Re-plan below.") +
      " Printouts are hidden until the schedule is up to date."),
    h("div", { className: current ? "" : "stale", id: current ? "" : "schedule-stale" },
      current ? null : h("p", {}, h("strong", {}, "Not current. "), "This is the old schedule, shown for reference only."),
      h("p", {}, "Planned for ", h("strong", {}, `${p.rounds} round${p.rounds !== 1 ? "s" : ""}`), `, ${p.fams.length} fams and ${p.hosts.length} host tables.`),
      h("div", { className: "metrics" },
        metric("Pairings that share an interest", `${sharedPairings(p)[0]} of ${sharedPairings(p)[1]}`, "A pairing shares an interest when the host and the fam list at least one of the same words. Open tables count as not sharing."),
        metric("Proven best possible", provenOptimal(p) ? "Yes" : "Not proven", "Yes means no other schedule with these tables and rules scores higher."),
        metric("Total match score", String(p.totalScore), "The sum of every pairing's score. Only useful to compare two plans for the same event.")),
      h("p", { className: "help" }, `In a good plan most pairings share at least one interest. Here ${weakCount(p)} of ${pairings} share none` + (openSlots(p).length ? " or have no host." : ".") +
        " Click Why? next to any pairing to see the reason, or to choose a different host."),
      ui.pinned ? h("div", { className: "msg ok row spread" }, ui.pinned.text,
        h("button", { className: "button", onclick: undoPin }, "Undo")) : null,
      fairness.length ? h("details", {}, h("summary", {}, `Fairness: ${fairness.length} thing${fairness.length !== 1 ? "s" : ""} to look at`),
        fairness.map((w) => h("p", {}, w.replace(/^Fairness check: /, "")))) : null,
      h("details", { open: unmatched > 0.3 }, h("summary", {}, "Notes on tags"),
        unmatched > 0.3 ? h("p", {}, `${Math.round(unmatched * 100)}% of the tags match nothing on the other side. A tag only counts when the host and the fam use the same words, for example computer science in both.`) : null,
        notes.length ? notes.map((w) => h("p", {}, w)) : h("p", {}, "Every tag is used on both sides.")),
      tabs, tabBody),
    current ? [
      h("h3", {}, "Print these four for the night"),
      h("div", { className: "cards" }, printouts.map(([label, file, make, help]) => h("div", { className: "card" },
        h("strong", {}, label), h("p", { className: "help" }, help),
        h("div", { className: "row" },
          h("button", { className: "button primary", onclick: () => openPage(make()) }, "Open to print"),
          h("button", { className: "button", onclick: () => download(fileName(file, "html"), make(), "text/html") }, "Download"))))),
      h("p", { className: "help" }, "Open a page, then print it from your browser on US Letter. Or download the page and print it later."),
      h("button", { className: "button link", onclick: () => download(fileName("schedule", "csv"), scheduleCsv(p), "text/csv") }, "Download the schedule as a spreadsheet"),
      h("div", { id: "printed" }, noteEl("printed"),
        h("div", { className: "row" },
          h("button", { className: "button", onclick: () => markPrinted() }, "Mark as printed"),
          h("span", { className: "help" }, ev.printed && ev.printedAt ? `Printed at ${ev.printedAt}. Changes below are listed against that version.`
            : ev.printed ? "Printed version marked. Changes below are listed against it." : "Not marked as printed yet. Click Mark as printed after you print."))),
      h("h3", {}, "For your team"),
      h("div", { className: "cards" },
        printCard("Backup packet", "backup packet", () => backupPacketHtml(p, ev.title, ev.printedAt), "The whole schedule on paper, for the coordinator, in case every device fails."),
        printCard("Plan summary", "plan summary", () => planSummaryHtml(p, ev.title, rulesInWords(), ev.notes), "One or two pages for a director: how good the plan is, the rules, and every pairing."),
        printCard("Runner sheets", "runner sheets", () => runnerSheetsHtml(p, ev.title, ui.runners, famLocations(ev)), `One page per runner (${ui.runners}): their tables, and who arrives at each one every round.`,
          runnersPicker()),
        printCard("Host badges", "host badges", () => hostBadgesHtml(p, ev.title, famLocations(ev)), "A card for each alum to slip behind their name badge, with their table every round.")),
    ] : null,
  );
}

function printCard(label: string, file: string, make: () => string, help: string, extra: HTMLElement | null = null): HTMLElement {
  return h("div", { className: "card" }, h("strong", {}, label), h("p", { className: "help" }, help), extra,
    h("div", { className: "row" },
      h("button", { className: "button primary", onclick: () => openPage(make()) }, "Open to print"),
      h("button", { className: "button", onclick: () => download(fileName(file, "html"), make(), "text/html") }, "Download")));
}

function runnersPicker(): HTMLElement {
  const sel = h("select", { "aria-label": "Runners" }, [1, 2, 3, 4].map((n) => h("option", { value: n, selected: n === ui.runners }, `${n} runner${n !== 1 ? "s" : ""}`))) as HTMLSelectElement;
  sel.addEventListener("change", () => { ui.runners = Number(sel.value); night.on ? nightRefresh() : steady(renderSchedule); });
  return sel;
}

function rulesInWords(): string[] {
  return ev.rules.filter((r) => r.rule && r.host_table).map((r) => {
    const when = r.rounds ? ` in round${/[,; ]/.test(r.rounds.trim()) ? "s" : ""} ${r.rounds}` : "";
    if (r.rule === "only in rounds") return `${r.host_table} only comes for round${/[,; ]/.test(r.rounds.trim()) ? "s" : ""} ${r.rounds}`;
    if (r.rule === "stays with") return `${r.host_table} stays with ${r.fam || "one fam"} all night`;
    return `${r.host_table} ${r.rule} ${r.fam}${when}`;
  });
}

function roundTable(p: EventPlan, round: number, current: boolean): HTMLElement {
  const tables = tableNumbers(p);
  const fams = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const body: HTMLElement[] = [];
  for (const f of fams) {
    const a = p.assignments.find((x) => x.round === round && x.groupId === f.groupId);
    const open = ui.explain && ui.explain.round === round && ui.explain.famId === f.groupId;
    body.push(h("tr", { className: a && a.score > 0 ? "" : "weak" },
      h("td", {}, String(tables[f.groupId])), h("td", {}, f.name), h("td", {}, slotText(p, round, f.groupId)), h("td", {}, a ? String(a.score) : "0"),
      h("td", {}, h("button", { className: "button small", "aria-expanded": open ? "true" : "false", onclick: () => {
        ui.explain = open ? null : { round, famId: f.groupId };
        steady(renderSchedule);
      } }, open ? "Close" : "Why?"))));
    if (open) body.push(h("tr", { className: "explain" }, h("td", { colSpan: 5 }, explainPanel(p, round, f.groupId, current))));
  }
  return h("div", { className: "scroll" }, h("table", { className: "plain schedule" },
    h("thead", {}, h("tr", {}, ["Table", "Fam", "Host table", "Score", ""].map((c) => h("th", {}, c)))), h("tbody", {}, body)));
}

function explainPanel(p: EventPlan, round: number, famId: string, current: boolean): HTMLElement {
  const x = explainPairing(p, round, famId);
  const pick = h("select", { "aria-label": `Host for ${famName(p, famId)} in round ${round}` },
    x.options.map((o) => h("option", { value: o.hostId, selected: o.current }, `${o.label}: score ${o.score}, ${o.where}`))) as HTMLSelectElement;
  return h("div", { className: "why" },
    x.lines.map((l) => h("p", {}, l)),
    current && !ev.plan!.lockedRounds.includes(round) && round > ev.finished ? h("div", { className: "row" },
      h("label", { className: "field" }, h("span", { className: "label" }, `Choose the host for round ${round}`), pick),
      h("button", { className: "button primary", onclick: () => pinHost(round, famId, pick.value) }, "Use this host")) :
      h("p", { className: "help" }, round <= ev.finished ? "This round already happened." : "Re-plan first, then you can choose a host here."),
    h("p", { className: "help" }, "Choosing a host adds a must meet rule for this round under Pairing rules, and re-plans everything else around it."));
}

async function pinHost(round: number, famId: string, hostId: string): Promise<void> {
  const p = ev.plan!;
  const host = p.hosts.find((x) => x.hostId === hostId)!;
  const fam = p.fams.find((x) => x.groupId === famId)!;
  if (p.assignments.some((a) => a.round === round && a.groupId === famId && a.hostId === hostId)) { ui.explain = null; steady(renderSchedule); return; }
  const before = { score: p.totalScore, shared: sharedPairings(p) };
  const rule: CleanRow = { rule: "must meet", host_table: host.name, fam: fam.name, rounds: String(round) };
  ev.rules.push(rule);
  const ok = await solve(hasStarted(ev) || ev.printed !== null, "tables");
  if (!ok) {
    const why = ui.solveError?.text ?? "";
    ev.rules = ev.rules.filter((r) => r !== rule);
    ui.solveError = null;
    note("schedule", "error", `${host.name} cannot meet ${fam.name} in round ${round}: ${why}`);
    refresh({ tables: true });
    return;
  }
  const q = ev.plan!;
  ui.explain = null;
  ui.pinned = {
    rule,
    text: `Done: ${host.name} meets ${fam.name} in round ${round}, kept as a must meet rule. ` +
      `Pairings that share an interest: ${before.shared[0]} of ${before.shared[1]} before, ${sharedPairings(q)[0]} of ${sharedPairings(q)[1]} now. ` +
      `Match score ${before.score} before, ${q.totalScore} now.`,
  };
  refresh({ tables: true });
}

async function undoPin(): Promise<void> {
  const pin = ui.pinned;
  if (!pin) return;
  const same = (r: CleanRow) => r.rule === pin.rule.rule && r.host_table === pin.rule.host_table && r.fam === pin.rule.fam && r.rounds === pin.rule.rounds;
  const i = ev.rules.findIndex(same);
  if (i >= 0) ev.rules.splice(i, 1);
  ui.pinned = null;
  const ok = await solve(hasStarted(ev) || ev.printed !== null, "tables");
  if (ok) note("schedule", "ok", "Undone: the rule is removed and the schedule is re-planned.");
  refresh({ tables: true });
}

function metric(label: string, value: string, help: string): HTMLElement {
  return h("div", { className: "metric", title: help }, h("span", { className: "help" }, label), h("span", { className: "value" }, value));
}

function markPrinted(backup = true): void {
  ev.printed = ev.plan;
  ev.printedAt = now();
  // A backup of exactly what was printed, in case this computer has trouble on the night.
  if (backup) download(fileName("printed backup", "rotation.json"), saveEvent(ev), "application/json");
  ui.savedHash = fileHash(ev);
  ui.savedAt = now();
  snapshot("marked as printed");
  note("printed", "ok", "Marked as printed, and a backup of the event file was downloaded. Keep it with the printouts, or on a second device. Later changes will be listed against this version.");
  refresh();
}

function renderChecklist(): void {
  const box = document.getElementById("checklist");
  if (!box) return;
  if (blank()) { replace(box); return; }
  const items = beforeTheNight(ev, fileHash(ev) === ui.savedHash);
  const left = items.filter((i) => i.status === "todo").length;
  const label = { done: "Done", todo: "To do", optional: "Optional" } as const;
  replace(box, h("details", { open: !!ev.plan && left > 0 },
    h("summary", {}, "Before the night: " + (left ? `${left} thing${left !== 1 ? "s" : ""} left to do` : "all done")),
    h("ul", { className: "checklist" }, items.map((i) => h("li", { className: i.status }, h("span", { className: "tag" }, label[i.status]), " ", i.text)))));
}

// ----------------------------------------------------------------------
// Changes on the night.
// ----------------------------------------------------------------------

function renderNight(): void {
  const box = document.getElementById("night")!;
  const p = ev.plan;
  if (!p) { replace(box); return; }
  const problems = currentProblems();
  const low = Math.max(0, ...p.lockedRounds);
  const finished = h("input", { type: "number", min: 0, max: p.rounds - 1, step: 1, value: Math.min(ev.finished, p.rounds - 1), "aria-label": "Rounds already finished" }) as HTMLInputElement;
  finished.addEventListener("change", () => {
    const v = Math.min(p.rounds - 1, Math.max(0, Math.floor(Number(finished.value) || 0)));
    if (v < low) { ui.unfinish = v; steady(renderNight); return; }
    ui.unfinish = null;
    ev.finished = v;
    refresh();
  });
  const wantLower = ui.unfinish;
  const openRounds = Array.from({ length: p.rounds - ev.finished }, (_, i) => ev.finished + 1 + i);
  const cancelRow = (kind: "host" | "fam") => {
    const names = kind === "host" ? p.hosts.map((x) => [x.name, x.hostId]) : p.fams.map((x) => [x.name, x.groupId]);
    const who = h("select", { "aria-label": `Cancel a ${kind}` }, names.map(([n, id]) => h("option", { value: id }, n))) as HTMLSelectElement;
    const from = h("select", { "aria-label": `${kind === "host" ? "Host" : "Fam"} misses from round` }, openRounds.map((r) => h("option", { value: r }, String(r)))) as HTMLSelectElement;
    return h("div", { className: "cancel-row" },
      field(`Cancel a ${kind}`, who), field("from round", from),
      h("button", { className: "button big", onclick: () => {
        ui.confirmCancel = { kind, id: who.value, name: who.selectedOptions[0].textContent ?? "", first: Number(from.value) };
        steady(renderNight);
      } }, `Cancel ${kind}`));
  };
  const cc = ui.confirmCancel;
  const cancelled = [
    ...Object.entries(ev.cancelHosts).map(([id, r]) => ["host", id, r, p.hosts.find((x) => x.hostId === id)?.name ?? id] as const),
    ...Object.entries(ev.cancelFams).map(([id, r]) => ["fam", id, r, p.fams.find((x) => x.groupId === id)?.name ?? id] as const),
  ];
  const err = ui.solveError && ui.solveError.fp === fingerprint(ev) && ui.solveError.where === "night" ? ui.solveError.text : "";
  const modeKeep = h("input", { type: "radio", name: "mode", value: "keep", checked: true }) as HTMLInputElement;
  const modeFresh = h("input", { type: "radio", name: "mode", value: "fresh" }) as HTMLInputElement;
  replace(box,
    h("h2", { id: "night-title" }, "5. Changes on the night"),
    h("div", { className: "msg info row spread" }, "On the night, use night mode: one screen with the round, check-in, where everyone is, cancellations, and late alumni. It works on a phone.",
      h("button", { className: "button primary", onclick: () => setNightMode(true) }, "Open night mode")),
    h("p", { className: "help" }, "In this order: set the rounds that already happened, cancel anyone who can't come, then click Re-plan. Finished rounds never change. Then reprint only the pages listed under Reprint."),
    field("Rounds already finished", finished),
    wantLower !== null ? h("div", { className: "msg warn" },
      `Round ${low} already happened, and you re-planned after it, so it is kept as it was. Un-finishing it lets round ${low} change again, so printed host cards for that round may no longer match.`,
      h("div", { className: "row" },
        h("button", { className: "button", onclick: () => {
          p.lockedRounds = p.lockedRounds.filter((r) => r <= wantLower);
          ev.finished = wantLower;
          ui.unfinish = null;
          note("night", "ok", `Round ${low} is no longer finished.`);
          refresh();
        } }, `Un-finish round ${low}`),
        h("button", { className: "button", onclick: () => { ui.unfinish = null; steady(renderNight); } }, "Keep it finished")))
      : low ? h("p", { className: "help" }, low > 1 ? `Rounds 1 to ${low} already happened and are kept as they were. To change them, lower this number.`
        : "Round 1 already happened and is kept as it was. To change it again, lower this number.") : null,
    noteEl("night"),
    openRounds.length ? [h("h3", {}, "Someone can't come"), cancelRow("host"), cancelRow("fam")] : null,
    cc ? h("div", { className: "panel confirm" },
      h("p", {}, "Cancel ", h("strong", {}, cc.name), ` from round ${cc.first}` + (cc.first < p.rounds ? " on?" : "?")),
      h("div", { className: "row" },
        h("button", { className: "button primary big", onclick: () => {
          if (cc.kind === "host") cancelHost(ev, cc.id, cc.first, now()); else cancelFam(ev, cc.id, cc.first, now());
          ui.confirmCancel = null;
          note("cancellations", "info", `${cc.name} is cancelled from round ${cc.first}. Click Re-plan to update the schedule.`);
          refresh();
        } }, `Yes, cancel ${cc.name}`),
        h("button", { className: "button big", onclick: () => { ui.confirmCancel = null; steady(renderNight); } }, "No, keep"))) : null,
    noteEl("cancellations"),
    cancelled.length ? [h("h3", {}, "Cancellations"), h("ul", { className: "cancellations" }, cancelled.map(([kind, id, r, name]) => {
      const applied = ((kind === "host" ? p.hostAway : p.famAway)[id] ?? []).includes(r);
      return h("li", {}, `${name}: cancelled from round ${r}` + (applied ? "" : " (waiting for Re-plan)"),
        r > ev.finished ? h("button", { className: "button small", onclick: () => {
          delete (kind === "host" ? ev.cancelHosts : ev.cancelFams)[id];
          refresh();
        } }, "Undo") : null);
    }))] : null,
    h("fieldset", { className: "mode" }, h("legend", {}, "How to re-plan"),
      h("label", {}, modeKeep, " Keep the printed schedule where possible"),
      h("label", {}, modeFresh, " Re-plan from scratch (nothing printed yet)")),
    h("button", { className: "button primary big wide", disabled: !!problems.length || ui.solving, onclick: async () => {
      snapshot("before re-planning on the night");
      const ok = await solve(modeKeep.checked, "night");
      if (ok) note("changes", "ok", "Schedule updated.");
      refresh({ tables: true, scrollTo: ok ? "changes" : "night-error" });
    } }, "Re-plan"),
    h("p", { id: "replan-status", className: "help" }),
    h("div", { id: "night-error" }, err ? h("div", { className: "msg error", role: "alert" }, err) : null),
    changesSincePrinted(),
  );
}

function changesSincePrinted(): HTMLElement {
  const p = ev.plan!;
  const printed = ev.printed;
  const box = h("div", { id: "changes" }, noteEl("changes"), h("h3", {}, "What changed since the printed version"));
  if (!printed) {
    box.appendChild(h("p", { className: "help" }, "Nothing is marked as printed yet. Click Mark as printed after you print, and changes will be listed here."));
    return box;
  }
  const tables = Object.fromEntries(p.fams.map((f) => [f.groupId, f.tableNumber]));
  const changes = planChanges(printed, p);
  box.appendChild(changes.length ? dataTable(changes.map((c) => ({
    Round: c.round, Table: tables[c.famId] ?? "", Fam: famName(p, c.famId),
    Printed: slotText(printed, c.round, c.famId), Now: slotText(p, c.round, c.famId),
  })), {}) : h("p", {}, "Nothing changed."));
  if (isCurrent(ev)) { const tell = tellPeople(p, printed); if (tell) box.appendChild(tell); }
  box.appendChild(reprintPanel(p, printed));
  return box;
}

function reprintPanel(p: EventPlan, printed: EventPlan): HTMLElement {
  const out = reprintList(printed, p);
  const box = h("div", {}, h("p", {}, h("strong", {}, "Reprint: "), describeReprint(out, p).join("; ") || "nothing."));
  if (isCurrent(ev)) {
    const stamp = now();
    const buttons: HTMLElement[] = [];
    if (out.hostIds.length) buttons.push(reprintButton("Reprint host cards", "host cards reprint", () => hostCardsHtml(p, out.hostIds, ev.title, stamp, famLocations(ev))));
    if (out.seatingChart) buttons.push(reprintButton("Reprint seating chart pages", "seating chart reprint", () => seatingChartHtml(p, ev.title, out.seatingRounds, out.finderPage, stamp, famLocations(ev))));
    if (out.famIds.length) buttons.push(reprintButton("Reprint table tents", "table tents reprint", () => tableTentsHtml(p, out.famIds, stamp)));
    if (buttons.length) {
      box.appendChild(h("div", { className: "cards" }, buttons));
      box.appendChild(h("p", { className: "help" }, "Reprinted pages say Updated with the time, so nobody uses an old copy."));
    }
  }
  return box;
}

/** Who has to be told what, against the printed cards, for the rounds still to come. */
function tellPeople(p: EventPlan, printed: EventPlan): HTMLElement | null {
  const m = movesBetween(printed, p, ev.finished + 1);
  if (!m.hosts.length && !m.fams.length) return null;
  const at = now();
  const told = new Set(ev.night.told ?? []);
  const again = () => (night.on ? nightRefresh() : (persist(), steady(renderNight)));
  const item = (key: string, text: string) => h("li", { className: told.has(key) ? "told" : "" },
    h("button", { className: `button small ${told.has(key) ? "primary" : ""}`, "aria-pressed": told.has(key) ? "true" : "false",
      onclick: () => { toggleTold(ev, key); again(); } }, told.has(key) ? "Told" : "Not told"),
    h("span", {}, text));
  const left = untold(m).length;
  return h("div", { className: "panel tell" },
    h("h3", {}, "What to tell people" + (left ? ` (${left} not told yet)` : ": everyone told")),
    m.hosts.length ? h("ul", { className: "told-list" }, m.hosts.map((x) => item(moveKey(x), x.text))) : null,
    m.fams.length ? h("ul", { className: "told-list" }, m.fams.map((x) => item(`fam|${x.round}|${x.famId}`, x.text))) : null,
    m.mc.length ? [h("p", { className: "help" }, "For the MC to read out:"), h("ul", {}, m.mc.map((x) => h("li", {}, x)))] : null,
    m.hosts.length ? h("div", { className: "row" },
      h("button", { className: "button primary", onclick: () => openPage(changeSlipsHtml(p, m.hosts, ev.title, at)) }, "Print change slips"),
      h("span", { className: "help" }, "One slip per alum, quicker than reprinting a whole card.")) : null);
}

const moveKey = (x: { round: number; hostId: string; now: string }) => `${x.round}|${x.hostId}|${x.now}`;

/** Changes from the printed plan nobody has been told about yet. */
function untold(m: ReturnType<typeof movesBetween>): string[] {
  const told = new Set(ev.night.told ?? []);
  return [...m.hosts.map(moveKey), ...m.fams.map((x) => `fam|${x.round}|${x.famId}`)].filter((k) => !told.has(k));
}

function reprintButton(label: string, file: string, make: () => string): HTMLElement {
  return h("div", { className: "card" }, h("strong", {}, label),
    h("div", { className: "row" },
      h("button", { className: "button primary", onclick: () => openPage(make()) }, "Open to print"),
      h("button", { className: "button", onclick: () => download(fileName(file, "html"), make(), "text/html") }, "Download")));
}


// ----------------------------------------------------------------------
// Night mode: one focused screen for the event itself.
// ----------------------------------------------------------------------

const MODE_KEY = "rotation-optimizer:mode";
const UI_KEY = "rotation-optimizer:ui"; // "guided" (the default) or "full"
let uiMode: "guided" | "full" = "guided";

function showPlanner(): void {
  if (uiMode === "guided") { renderGuided(guidedCtx); return; }
  renderShell();
  renderTopNote();
  renderTables();
  refresh();
}

function setUi(mode: "guided" | "full"): void {
  uiMode = mode;
  try { localStorage.setItem(UI_KEY, mode); } catch { /* remembered for this visit only */ }
  if (mode === "guided" && location.hash === "#full") history.replaceState(null, "", location.pathname + location.search);
  showPlanner();
  window.scrollTo(0, 0);
}

const guidedCtx: GuidedCtx = {
  get: () => ev,
  set: (next) => {
    if (!practiceOriginal && (ev.hosts.length || ev.fams.length)) snapshot("before opening another event");
    ev = next;
    ui.savedHash = fileHash(ev);
    ui.solveError = null;
    persist();
  },
  persist,
  now,
  solve: async (keep) => {
    const ok = await solve(keep, "tables");
    return ok ? "" : ui.solveError?.text ?? "Something went wrong.";
  },
  openNight: () => setNightMode(true),
  openFull: () => setUi("full"),
  practice: () => {
    practiceOriginal = ev;
    ev = loadEvent(saveEvent(ev));
    renderGuided(guidedCtx);
  },
  endPractice,
  tryExample: () => {
    if (!practiceOriginal) practiceOriginal = ev;
    ev = practiceEvent();
  },
  inPractice: () => practiceOriginal !== null,
  saveFile,
  handOff,
  markPrinted: () => markPrinted(false),
  fileName,
  removeStudentNames,
  offlineCopy: downloadOfflineCopy,
};
interface NightUi {
  on: boolean; query: string; showNext: boolean; late: boolean; lateProblem: string;
  confirm: { kind: "host" | "fam"; id: string; label: string; first: number; noShow: boolean } | null;
  justFinished: number | null;
  before: EventPlan | null; // the plan before the last re-plan, when nothing is marked printed
  action: string | null; // which "Something changed?" form is open
  renumber: string | null; // fam id whose table number is being corrected
  lateJoin: string | null; // host id joining late
  problem: string; // the last room action's problem, in plain words
  actual: string | null; // fam id whose table is being corrected to what actually happened
  startAnyway: boolean; // start round 1 although setup is not finished
}
const night: NightUi = {
  on: false, query: "", showNext: false, late: false, lateProblem: "", confirm: null, justFinished: null, before: null,
  renumber: null, lateJoin: null, problem: "", actual: null, startAnyway: false, action: null,
};

const CHANGES: [string, string][] = [
  ["leave", "An alum isn't here, or has to leave"],
  ["late", "A missing alum arrived"],
  ["new", "A new alum came"],
  ["table", "A fam is at a different table"],
  ["fam", "A fam has to leave"],
];
const TOOLS: [string, string][] = [
  ["room", "Room setup"], ["checkin", "Check-in"], ["students", "Students"], ["where", "Where is…"], ["share", "QR code for volunteers"], ["log", "What happened tonight"],
];
let clockTimer = 0;

function setNightMode(on: boolean): void {
  night.on = on;
  try { localStorage.setItem(MODE_KEY, on ? "night" : "plan"); } catch { /* fine: it only remembers the screen */ }
  clearInterval(clockTimer);
  if (on) {
    renderNightMode();
    clockTimer = window.setInterval(() => {
      const c = document.getElementById("night-clock");
      if (c) c.textContent = now();
    }, 15000);
    window.scrollTo(0, 0);
  } else if (uiMode === "guided") {
    renderGuided(guidedCtx);
  } else {
    renderShell();
    renderTables();
    refresh({ scrollTo: "night" });
  }
}

// Night mode re-renders after every tap, so remember which panels are open.
const nightOpen = new Map<string, boolean>();
function panel(key: string, openByDefault: boolean, summary: string, ...body: Parameters<typeof h>[2][]): HTMLElement {
  // Only a tap on the summary counts: the browser also fires "toggle" for panels drawn open.
  const head = h("summary", {}, summary);
  const el = h("details", { className: "panel", open: nightOpen.get(key) ?? openByDefault, "data-panel": key }, head, ...body) as HTMLDetailsElement;
  head.addEventListener("click", () => nightOpen.set(key, !el.open));
  return el;
}

function nightRefresh(): void {
  persist();
  const y = window.scrollY;
  renderNightMode();
  window.scrollTo(0, y);
}

function hostLabelRow(id: string): string {
  const r = ev.hosts.find((x) => x.host_id === id);
  return r ? ((r.host_name && r.host_name !== r.table_label ? `${r.host_name} (${r.table_label})` : r.table_label)) : id;
}

/** The few things a coordinator needs at a glance, at the top of night mode. */
function nowBoard(p: EventPlan, current: boolean): HTMLElement {
  const st = status(ev, nowMinutes());
  const r = st.round;
  const items: [string, string, string][] = []; // [kind, text, panel to open]
  if (st.phase === "during" && st.minutesLeft !== null) items.push([st.minutesLeft < 0 ? "warn" : st.minutesLeft <= 3 ? "info" : "ok", `Round ${r}: ${leftText(st.minutesLeft)}`, ""]);
  if (st.phase === "moving") {
    const moving = transitions(p, r).filter((t) => t.toTable !== null);
    const done = moving.filter((t) => (ev.night.moved ?? []).includes(t.key)).length;
    items.push([done === moving.length ? "ok" : "warn", `Moving to round ${r}: ${done} of ${moving.length} alumni ticked off at their tables`, ""]);
  }
  if (st.lateBy >= 5 && st.phase !== "over") items.push(["warn", `Running ${st.lateBy} minutes late` + (st.projectedEnd !== null ? `, ending about ${shown(st.projectedEnd)}` : ""), ""]);
  const open = current && st.phase !== "over" ? openTables(p, r) : [];
  if (open.length) items.push(["warn", `No host in round ${r}: ${open.join(", ")}`, ""]);
  const missing = notArrived(ev);
  if (missing.length && ev.finished === 0) items.push(["warn", `${missing.length} alum${missing.length !== 1 ? "ni" : ""} not checked in`, "checkin"]);
  const setupLeft = setupMissing(ev).length;
  if (setupLeft && st.phase === "before") items.push(["warn", `${setupLeft} table${setupLeft !== 1 ? "s" : ""} not checked in room setup`, "room"]);
  const base = ev.printed ?? night.before;
  const notTold = current && base ? untold(movesBetween(base, p, ev.finished + 1)).length : 0;
  if (notTold) items.push(["warn", `${notTold} change${notTold !== 1 ? "s" : ""} not passed on yet`, ""]);
  const short = st.phase === "before" || (st.phase === "during" && r === 1) ? shortFams(p) : [];
  if (short.length) items.push(["warn", `Few students yet at ${short.slice(0, 3).join(", ")}${short.length > 3 ? "…" : ""}`, "students"]);
  if (!current) items.push(["error", "Changes are waiting: tap to update", "update"]);
  if (!items.length) items.push(["ok", "All good.", ""]);
  return h("section", { className: "now-board", "aria-label": "Right now" }, items.map(([kind, text, key]) =>
    h("button", { className: `chip ${kind}`, onclick: () => {
      if (key === "update") { document.getElementById("update-now")?.scrollIntoView({ block: "center" }); (document.querySelector("#update-now + button") as HTMLButtonElement | null)?.click(); return; }
      if (!key) return;
      nightOpen.set(key, true);
      nightRefresh();
      document.querySelector(`[data-panel="${key}"]`)?.scrollIntoView({ block: "start" });
    } }, text)));
}

/** The round, its clock, and the one button that moves the night forward. */
function roundSection(p: EventPlan): HTMLElement {
  const st = status(ev, nowMinutes());
  const r = st.round;
  const t = ev.night.roundTimes ?? {};
  const setupLeft = setupMissing(ev);
  const start = () => { startRound(ev, r, nowMinutes()); logChange(ev, now(), `Round ${r} started.`); night.startAnyway = false; nightRefresh(); };
  let action: HTMLElement;
  if (st.phase === "before") {
    action = setupLeft.length && !night.startAnyway
      ? h("div", { className: "msg warn" }, `Room setup is not finished: ${setupLeft.length > 2 ? `${setupLeft.length} tables` : setupLeft.join(" and ")} not checked yet.`,
        h("div", { className: "row" },
          h("button", { className: "button", onclick: () => { nightOpen.set("room", true); nightRefresh(); document.querySelector('[data-panel="room"]')?.scrollIntoView({ block: "start" }); } }, "Check the tables"),
          h("button", { className: "button primary", onclick: start }, "Start anyway")))
      : h("button", { className: "button primary big wide", onclick: start }, "Start round 1");
  } else if (st.phase === "moving") {
    action = h("button", { className: "button primary big wide", onclick: start }, `Start round ${r}`);
  } else if (st.phase === "during") {
    action = h("button", { className: "button primary big wide", onclick: () => {
      endRound(ev, r, nowMinutes());
      night.showNext = false;
      if (r < p.rounds) { finishRound(ev, now()); night.justFinished = ev.finished; }
      else logChange(ev, now(), `Round ${r} finished. The event is over.`);
      nightRefresh();
    } }, r < p.rounds ? `End round ${r}: alumni move to round ${r + 1}` : `End round ${r}: the event is over`);
  } else {
    action = h("p", {}, "The event is over. Thank the hosts and the fams.");
  }
  const timesLine = Object.keys(t).length ? h("p", { className: "help" }, Object.entries(t).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) =>
    `Round ${k}: ${v.start ? shown(toMinutes(v.start)!) : "?"}${v.end ? ` to ${shown(toMinutes(v.end)!)}` : ""}`).join(" · ")) : null;
  const moving = st.phase === "moving" ? transitions(p, r) : [];
  const moved = new Set(ev.night.moved ?? []);
  return h("section", { className: "panel round-now" },
    h("p", { className: "big-round" }, st.phase === "moving" ? `Moving to round ${r} of ${p.rounds}` : st.phase === "over" ? "Finished" : `Round ${r} of ${p.rounds}`),
    st.phase === "during" && st.minutesLeft !== null ? h("p", { className: `clock-left ${st.minutesLeft < 0 ? "over" : ""}` }, leftText(st.minutesLeft)) : null,
    st.lateBy >= 5 && st.phase !== "over" ? h("p", { className: "warn-text" }, `Running ${st.lateBy} minutes late.` +
      (st.projectedEnd !== null ? ` At this pace the event ends about ${shown(st.projectedEnd)}` + (st.plannedEnd !== null ? `, not ${shown(st.plannedEnd)}.` : ".") : "") +
      (st.catchUp ? ` To finish on time, make the remaining rounds ${st.catchUp} minutes and tell the MC.` : "")) : null,
    action,
    night.justFinished === ev.finished && st.phase === "moving" && ev.finished > Math.max(0, ...p.lockedRounds) ? h("p", { className: "help" }, `Round ${ev.finished} marked finished. `,
      h("button", { className: "button link", onclick: () => {
        ev.finished -= 1; night.justFinished = null;
        const k = String(ev.finished + 1);
        const rt = ev.night.roundTimes ?? {};
        if (rt[k]) ev.night = { ...ev.night, roundTimes: { ...rt, [k]: { start: rt[k].start } } };
        logChange(ev, now(), `Round ${ev.finished + 1} un-finished.`);
        nightRefresh();
      } }, "Undo")) : null,
    moving.length ? h("div", { className: "transition" },
      h("p", { className: "help" }, "Tick each alum when they reach their table. Two runners: one takes the top half of the list, the other the bottom half."),
      h("ul", { className: "moves" }, moving.map((m) => h("li", { className: moved.has(m.key) ? "done" : "" },
        h("button", { className: `button small ${moved.has(m.key) ? "primary" : ""}`, "aria-pressed": moved.has(m.key) ? "true" : "false",
          onclick: () => { toggleMoved(ev, m.key); nightRefresh(); } }, moved.has(m.key) ? "There" : "Moving"),
        h("span", { className: "who" }, m.who), h("span", { className: "help" }, `${m.from} to ${m.to}`))))) : null,
    timesLine,
    st.phase !== "before" ? h("button", { className: "button small", onclick: () => openPage(mcCueCardHtml(ev, p, nowMinutes())) }, "Print the MC cue card with updated times") : null);
}


/** Fams with fewer than half their students checked in, by table. */
function shortFams(p: EventPlan): string[] {
  const got = ev.night.famArrived ?? {};
  if (!Object.keys(got).length) return [];
  const tables = tableNumbers(p);
  return p.fams.filter((f) => (f.size || f.members.length) > 0 && (got[f.groupId] ?? 0) < (f.size || f.members.length) / 2)
    .sort((a, b) => tables[a.groupId] - tables[b.groupId]).map((f) => `Table ${tables[f.groupId]}`);
}

function studentsPanel(p: EventPlan): HTMLElement {
  const tables = tableNumbers(p);
  const got = ev.night.famArrived ?? {};
  const fams = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const total = fams.reduce((n, f) => n + (got[f.groupId] ?? 0), 0);
  const expected = fams.reduce((n, f) => n + (f.size || f.members.length), 0);
  const bump = (id: string, d: number) => {
    ev.night = { ...ev.night, famArrived: { ...got, [id]: Math.max(0, (got[id] ?? 0) + d) } };
    nightRefresh();
  };
  return panel("students", false, `Students: ${total}${expected ? ` of ${expected}` : ""} here`,
    h("p", { className: "help" }, "Count students as they sit down at each table. A fam that is mostly missing at the start may need a host moved, or two fams merged."),
    h("ul", { className: "counts" }, fams.map((f) => {
      const n = got[f.groupId] ?? 0, want = f.size || f.members.length;
      return h("li", { className: want && n < want / 2 ? "short" : "" },
        h("span", { className: "tn" }, `Table ${tables[f.groupId]}`), h("span", {}, f.name),
        h("span", { className: "n" }, want ? `${n} of ${want}` : String(n)),
        h("button", { className: "button small", "aria-label": `One fewer at ${f.name}`, onclick: () => bump(f.groupId, -1) }, "−"),
        h("button", { className: "button small", "aria-label": `One more at ${f.name}`, onclick: () => bump(f.groupId, 1) }, "+"));
    })));
}

let shareCache: { key: string; link: string } | null = null;

function sharePanel(p: EventPlan, current: boolean): HTMLElement {
  const box = h("div", { id: "share-box" });
  const base = location.protocol.startsWith("http") ? new URL("view.html", location.href).href : "https://chrishoangle.github.io/rotation-optimizer/app/view.html";
  const key = fingerprint(ev) + "|" + currentRound(ev);
  const show = (link: string) => replace(box,
    h("div", { className: "qr" }),
    h("p", { className: "help" }, "Volunteers scan this with their phone camera to see who is where, round by round. It works offline once opened. It never shows student names."),
    h("div", { className: "row" },
      h("button", { className: "button", onclick: async () => { try { await navigator.clipboard.writeText(link); night.problem = ""; } catch { /* the QR code still works */ } } }, "Copy the link"),
      h("button", { className: "button", onclick: () => openPage(runnerSheetsHtml(p, ev.title, ui.runners, famLocations(ev))) }, `Print runner sheets (${ui.runners})`)));
  const paint = (link: string) => { show(link); const q = box.querySelector(".qr"); if (q) q.innerHTML = qrSvg(link); };
  if (shareCache && shareCache.key === key) paint(shareCache.link);
  else if (current) {
    encodeSnapshot(snapshotFor(p, ev.title, now(), currentRound(ev), famLocations(ev))).then((data) => {
      shareCache = { key, link: `${base}#${data}` };
      paint(shareCache.link);
    }).catch(() => replace(box, h("p", { className: "help" }, "This browser cannot make the code. Print the runner sheets instead.")));
  } else replace(box, h("p", { className: "help" }, "Re-plan first, then show the new code: an old code shows the old schedule."));
  return panel("share", false, "Show volunteers who is where (QR code)", box,
    h("p", { className: "help" }, "After every re-plan the code changes. Ask volunteers to scan it again."));
}

function wrapUpPanel(): HTMLElement | null {
  const st = status(ev, nowMinutes());
  if (st.phase !== "over" || ev.night.wrapUp) return null;
  const box = h("textarea", { rows: 4, "aria-label": "What would you change next year?", placeholder: "For example: start check-in 15 minutes earlier; Table 7 is too loud." }) as HTMLTextAreaElement;
  return h("section", { className: "panel wrap" },
    h("h2", {}, "Before you go: what would you change next year?"),
    h("p", { className: "help" }, "Two minutes now saves next year's coordinator an evening. This goes into Notes for next year and the hand-off."),
    box,
    h("div", { className: "row" },
      h("button", { className: "button primary", onclick: () => {
        const text = box.value.trim();
        if (text) ev.notes = (ev.notes.trim() ? ev.notes.trim() + "\n\n" : "") + `After the event (${new Date().toLocaleDateString()}): ${text}`;
        ev.night = { ...ev.night, wrapUp: true };
        logChange(ev, now(), text ? "Notes for next year added." : "Wrap-up skipped.");
        nightRefresh();
      } }, "Save to notes for next year"),
      h("button", { className: "button", onclick: () => { ev.night = { ...ev.night, wrapUp: true }; nightRefresh(); } }, "Skip")));
}

function renderNightMode(): void {
  const app = document.getElementById("app")!;
  const p = ev.plan;
  const exit = h("button", { className: "button", onclick: () => setNightMode(false) }, "Back to planning");
  if (!p) {
    replace(app, h("main", { className: "night-mode" },
      h("div", { className: "night-bar" }, h("strong", {}, ev.title), exit),
      h("div", { className: "msg info" }, "Make a schedule first: go back to planning and click Find the best schedule.")));
    return;
  }
  const cur = currentRound(ev);
  const last = cur >= p.rounds;
  const current = isCurrent(ev);
  const err = ui.solveError && ui.solveError.fp === fingerprint(ev) && ui.solveError.where === "night" ? ui.solveError.text : "";
  const tables = tableNumbers(p);
  const showRound = night.showNext && !last ? cur + 1 : cur;
  const rows = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]).map((f) => {
    const a = p.assignments.find((x) => x.round === showRound && x.groupId === f.groupId);
    const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
    const gone = (p.famAway[f.groupId] ?? []).includes(showRound);
    const fixing = night.actual === f.groupId && showRound === cur;
    return h("li", { className: host ? "" : "empty" },
      h("span", { className: "tn" }, `Table ${tables[f.groupId]}`),
      h("span", { className: "fam" }, f.name),
      h("span", { className: "who" }, gone ? "Fam cancelled" : host ? (hostLabel(host)) : "No host"),
      showRound === cur && !gone && current ? h("button", { className: "button small", onclick: () => { night.actual = fixing ? null : f.groupId; nightRefresh(); } }, fixing ? "Close" : "Not right?") : null,
      fixing ? (() => {
        const pick = h("select", { "aria-label": `Who is actually at Table ${tables[f.groupId]}` },
          p.hosts.filter((x) => !(p.hostAway[x.hostId] ?? []).includes(cur)).map((x) => h("option", { value: x.hostId, selected: x.hostId === host?.hostId }, hostLabel(x)))) as HTMLSelectElement;
        return h("div", { className: "row actual" },
          h("span", { className: "help" }, "Who is actually there? If moving them would be worse, keep it, and the rest of the night is re-planned around it."),
          pick,
          h("button", { className: "button primary", onclick: () => {
            night.problem = recordActual(ev, f.groupId, pick.value, cur, now());
            night.actual = null;
            nightRefresh();
          } }, "Keep it this way"));
      })() : null);
  });

  // Where is...
  const search = h("input", { type: "search", value: night.query, placeholder: "Type an alum, host table, fam, or student", "aria-label": "Where is" }) as HTMLInputElement;
  const results = h("div", { id: "where-results" });
  const showResults = () => replace(results, whereIs(p, night.query, cur).map((f) =>
    h("div", { className: "found" }, h("strong", {}, f.title), h("ul", {}, f.lines.map((l) => h("li", {}, l))))),
  night.query.trim().length >= 2 && !whereIs(p, night.query, cur).length ? h("p", { className: "help" }, "No match.") : null);
  search.addEventListener("input", () => { night.query = search.value; showResults(); });
  showResults();

  // Check-in.
  const expected = ev.hosts.filter((r) => r.host_id && r.table_label && !(r.host_id in ev.cancelHosts));
  const noShows = ev.hosts.filter((r) => r.host_id && r.table_label && r.host_id in ev.cancelHosts && !ev.arrived.includes(r.host_id));
  const here = expected.filter((r) => ev.arrived.includes(r.host_id)).length;
  const openRounds = Array.from({ length: p.rounds - ev.finished }, (_, i) => ev.finished + 1 + i);
  const lateRow = (id: string) => {
    const underWay = !!ev.night.roundTimes?.[String(cur)]?.start && !ev.night.roundTimes?.[String(cur)]?.end;
    const from = h("select", { "aria-label": "Hosts from round" }, openRounds.map((r) => h("option", { value: r, selected: r === Math.min(p.rounds, underWay ? cur + 1 : cur) }, `hosts from round ${r}`))) as HTMLSelectElement;
    return h("div", { className: "row" }, from,
      h("button", { className: "button primary", onclick: () => {
        night.problem = joinLate(ev, id, Number(from.value), now());
        night.lateJoin = null;
        nightRefresh();
      } }, "Add them back"),
      h("button", { className: "button", onclick: () => { night.lateJoin = null; nightRefresh(); } }, "Cancel"));
  };
  const missing = notArrived(ev);
  const checkIn = panel("checkin", ev.finished === 0 || night.lateJoin !== null, `Check-in: ${here} of ${expected.length} alumni here`,
    h("ul", { className: "checkin" }, expected.map((r) => {
      const isHere = ev.arrived.includes(r.host_id);
      return h("li", {},
        h("button", { className: `button ${isHere ? "primary" : ""}`, "aria-pressed": isHere ? "true" : "false", onclick: () => {
          ev.arrived = isHere ? ev.arrived.filter((x) => x !== r.host_id) : [...ev.arrived, r.host_id];
          nightRefresh();
        } }, isHere ? "Here" : "Not here yet"),
        h("span", {}, hostLabelRow(r.host_id)),
        !isHere ? h("button", { className: "button small", onclick: () => {
          night.confirm = { kind: "host", id: r.host_id, label: hostLabelRow(r.host_id), first: cur, noShow: true };
          nightRefresh();
          document.querySelector(".panel.confirm")?.scrollIntoView({ block: "center" });
        } }, "Didn't show") : null,
        !isHere && ev.finished > 0 ? h("button", { className: "button small", onclick: () => { night.lateJoin = r.host_id; nightRefresh(); } }, "Arrived late") : null,
        night.lateJoin === r.host_id ? lateRow(r.host_id) : null);
    }),
    noShows.map((r) => h("li", { className: "noshow" },
      h("span", { className: "tag-out" }, (ev.cancelHosts[r.host_id] ?? 1) > 1 ? `Left after round ${ev.cancelHosts[r.host_id] - 1}` : "Didn't show"),
      h("span", {}, hostLabelRow(r.host_id)),
      h("button", { className: "button small", onclick: () => { night.lateJoin = r.host_id; nightRefresh(); } }, (ev.cancelHosts[r.host_id] ?? 1) > 1 ? "Came back" : "Arrived late"),
      night.lateJoin === r.host_id ? lateRow(r.host_id) : null))),
    missing.length && ev.finished === 0 ? h("p", { className: "help" }, `${missing.length} not here yet. If someone doesn't come, tap Didn't show next to their name, then Update the schedule.`) : null,
    h("p", { className: "help" }, "A student who walks in just joins a fam: nothing to change here."));

  // Someone has to leave.
  const leave = (kind: "host" | "fam") => {
    const options = kind === "host"
      ? ev.hosts.filter((r) => r.host_id && r.table_label && !(r.host_id in ev.cancelHosts)).map((r) => [r.host_id, hostLabelRow(r.host_id)])
      : ev.fams.filter((r) => r.fam_id && r.fam_label && !(r.fam_id in ev.cancelFams)).map((r) => [r.fam_id, r.fam_label]);
    const who = h("select", { "aria-label": kind === "host" ? "Alum who has to leave" : "Fam that has to leave" },
      h("option", { value: "" }, kind === "host" ? "Choose an alum…" : "Choose a fam…"), options.map(([id, l]) => h("option", { value: id }, l))) as HTMLSelectElement;
    const from = h("select", { "aria-label": kind === "host" ? "Alum misses from round" : "Fam misses from round" },
      openRounds.map((r) => h("option", { value: r, selected: r === cur }, `from round ${r}`))) as HTMLSelectElement;
    return h("div", { className: "row leave" }, who, from,
      h("button", { className: "button", onclick: () => {
        if (!who.value) return;
        night.confirm = { kind, id: who.value, label: who.selectedOptions[0].textContent ?? "", first: Number(from.value), noShow: false };
        nightRefresh();
        document.querySelector(".panel.confirm")?.scrollIntoView({ block: "center" });
      } }, kind === "host" ? "Alum can't stay" : "Fam can't stay"));
  };
  const c = night.confirm;
  const confirm = c ? h("div", { className: "panel confirm", role: "alertdialog" },
    h("p", {}, c.noShow ? `${c.label} didn't show up. Cancel them from round ${c.first}?` : `Cancel ${c.label} from round ${c.first}` + (c.first < p.rounds ? " on?" : "?")),
    h("div", { className: "row" },
      h("button", { className: "button primary big", onclick: () => {
        if (c.kind === "host") cancelHost(ev, c.id, c.first, now(), c.noShow);
        else cancelFam(ev, c.id, c.first, now());
        night.confirm = null;
        nightRefresh();
        document.getElementById("update-now")?.scrollIntoView({ block: "center" });
      } }, "Yes, cancel"),
      h("button", { className: "button big", onclick: () => { night.confirm = null; nightRefresh(); } }, "No"))) : null;

  // The room: tents on the right tables, and fams sitting somewhere else.
  const setupDone = new Set(ev.night.setup ?? []);
  const located = famLocations(ev);
  const stepFree = new Set(stepFreeFams(ev));
  const renumberRow = (famId: string) => {
    const box = h("input", { type: "number", min: 1, step: 1, "aria-label": "Table the fam is at", placeholder: "Table number" }) as HTMLInputElement;
    return h("div", { className: "row" }, box,
      h("button", { className: "button primary", onclick: () => {
        night.problem = moveFamTable(ev, famId, Number(box.value), now());
        if (!night.problem) night.renumber = null;
        nightRefresh();
      } }, "They are at this table"),
      h("button", { className: "button", onclick: () => { night.renumber = null; night.problem = ""; nightRefresh(); } }, "Cancel"));
  };
  const room = roomTables(ev);
  const famsByTable = [...p.fams].filter((f) => f.groupId in room).sort((a, b) => room[a.groupId] - room[b.groupId]);
  const setupLeft = famsByTable.filter((f) => !setupDone.has(f.groupId)).length;
  function roomRow(famId: string, name: string): HTMLElement {
    const ok = setupDone.has(famId);
    return h("li", {},
      h("button", { className: `button ${ok ? "primary" : ""}`, "aria-pressed": ok ? "true" : "false", onclick: () => { toggleSetup(ev, famId); night.problem = ""; nightRefresh(); } }, ok ? "Checked" : "Check"),
      h("span", { className: "tn" }, `Table ${room[famId]}`),
      h("span", {}, name, located[famId] ? h("span", { className: "help" }, ` · ${located[famId]}`) : null, stepFree.has(famId) ? h("span", { className: "help" }, " · step-free") : null),
      h("button", { className: "button small", onclick: () => { night.renumber = famId; night.problem = ""; nightRefresh(); } }, "Different table"),
      night.renumber === famId ? renumberRow(famId) : null);
  }
  const lateList = (_p: EventPlan) => {
    const comesLater = (id: string) => (p.hostLimits[id] ?? []).includes(cur);
    const away = [...noShows, ...expected.filter((r) => !ev.arrived.includes(r.host_id) && ev.finished > 0 && !comesLater(r.host_id))];
    if (!away.length) return h("p", { className: "help" }, "Everyone expected is checked in. For someone who wasn't on the list, choose A new alum came.");
    return h("ul", { className: "checkin" }, away.map((r) => h("li", {},
      h("span", {}, hostLabelRow(r.host_id)),
      h("button", { className: `button small ${night.lateJoin === r.host_id ? "primary" : ""}`, onclick: () => { night.lateJoin = r.host_id; nightRefresh(); } }, "They're here"),
      night.lateJoin === r.host_id ? lateRow(r.host_id) : null)));
  };
  const roomPanelBody = h("ul", { className: "setup" }, famsByTable.map((f) => roomRow(f.groupId, f.name)));
  const roomPanel = panel("room", true,
    setupLeft ? `Room setup: ${famsByTable.length - setupLeft} of ${famsByTable.length} tables checked` : "Room setup: every table checked",
    h("p", { className: "help" }, "Before doors open, put each tent on its table, walk the room, and tap Check for each one. If a fam is already sitting at a different table, don't move the students: tap Different table and type the number they are at."),
    h("ul", { className: "setup" }, famsByTable.map((f) => roomRow(f.groupId, f.name))),
    h("button", { className: "button", onclick: () => openPage(setupSheetHtml(famsByTable.map((f) => ({
      table: room[f.groupId], fam: f.name, location: located[f.groupId] ?? "", stepFree: stepFree.has(f.groupId), students: f.size || f.members.length,
    })), ev.title)) }, "Print the setup sheet"));

  // A late alum.
  const lateBox = night.late ? (() => {
    const table = h("input", { type: "text", "aria-label": "Host table name", placeholder: "Host table name, for example Real Estate" }) as HTMLInputElement;
    const person = h("input", { type: "text", "aria-label": "Alum's name", placeholder: "Alum's name" }) as HTMLInputElement;
    const tags = h("input", { type: "text", "aria-label": "Tags", placeholder: "Tags, for example finance; real estate" }) as HTMLInputElement;
    const from = h("select", { "aria-label": "Joins from round" }, openRounds.map((r) => h("option", { value: r }, `Joins from round ${r}`))) as HTMLSelectElement;
    return h("div", { className: "panel" },
      h("h3", {}, "Add a late alum"),
      table, person, tags, from,
      night.lateProblem ? h("div", { className: "msg error" }, night.lateProblem) : null,
      h("div", { className: "row" },
        h("button", { className: "button primary", onclick: () => {
          night.lateProblem = addLateHost(ev, { table: table.value, person: person.value, tags: tags.value, from: Number(from.value) }, now());
          if (!night.lateProblem) night.late = false;
          nightRefresh();
        } }, "Add"),
        h("button", { className: "button", onclick: () => { night.late = false; night.lateProblem = ""; nightRefresh(); } }, "Cancel")));
  })() : h("button", { className: "button wide", onclick: () => { night.late = true; nightRefresh(); } }, "An alum arrived late, or a new one came");

  replace(app, h("main", { className: "night-mode", id: "main" },
    h("div", { className: "night-bar" },
      h("div", {}, h("strong", {}, ev.title), " ", h("span", { id: "night-clock", className: "help" }, now())),
      exit),
    practiceBanner(),
    nowBoard(p, current),
    roundSection(p),
    !current || err ? h("section", { className: "panel stale-panel" },
      h("p", { id: "update-now" }, h("strong", {}, "Changes are waiting. "), "The schedule below is the old one until you update it."),
      h("button", { className: "button primary big wide", disabled: ui.solving, onclick: async () => {
        snapshot("before re-planning on the night");
        night.before = ev.plan;
        const ok = await solve(true, "night");
        if (ok) logChange(ev, now(), "Re-planned.");
        nightRefresh();
      } }, "Update the schedule"),
      h("p", { id: "replan-status", className: "help" }),
      err ? h("div", { className: "msg error", role: "alert" }, err) : null) : null,
    current && (ev.printed || night.before) ? (() => {
      const base = ev.printed ?? night.before!;
      const tell = tellPeople(p, base);
      return tell ? [tell, ev.printed ? h("section", { className: "panel" }, reprintPanel(p, ev.printed)) : null] : null;
    })() : null,
    confirm,
    night.problem ? h("div", { className: "msg error", role: "alert" }, night.problem) : null,
    h("section", { className: "panel" },
      h("div", { className: "row spread" },
        h("h2", {}, showRound === cur ? `Round ${cur}: who is where` : `Next, round ${showRound}`),
        last ? null : h("button", { className: "button small", onclick: () => { night.showNext = !night.showNext; nightRefresh(); } },
          night.showNext ? `Show round ${cur}` : `Show round ${cur + 1}`)),
      current ? null : h("p", { className: "help warn-text" }, "This is the old schedule. Tap Update the schedule at the top to see the changes."),
      h("ul", { className: "now-list" }, rows)),
    h("section", { className: "panel changed" },
      h("h2", {}, "Someone changed?"),
      h("div", { className: "change-buttons" }, CHANGES.map(([key, label]) =>
        h("button", { className: `button ${night.action === key ? "primary" : ""}`, "aria-expanded": night.action === key ? "true" : "false",
          onclick: () => { night.action = night.action === key ? null : key; night.late = key === "new"; night.problem = ""; nightRefresh(); } }, label))),
      night.action === "leave" ? [h("p", { className: "help" }, "Choose the alum and the first round they miss. Didn't show up? Choose this round."), leave("host")] : null,
      night.action === "late" ? lateList(p) : null,
      night.action === "new" ? lateBox : null,
      night.action === "table" ? [h("p", { className: "help" }, "Find the fam in the list, tap Different table, and type the number they are sitting at. Don't move the students."), roomPanelBody] : null,
      night.action === "fam" ? leave("fam") : null,
      night.action ? h("p", { className: "help" }, "Then tap Update the schedule at the top. Finished rounds never change.") : null),
    wrapUpPanel(),
    h("section", { className: "tools" }, h("span", { className: "help" }, "Tools: "), TOOLS.map(([key, label]) =>
      h("button", { className: `button small ${nightOpen.get(key) ? "primary" : ""}`, "aria-expanded": nightOpen.get(key) ? "true" : "false",
        onclick: () => {
          // One tool at a time, so the page stays short on a phone.
          const open = !nightOpen.get(key);
          for (const [k] of TOOLS) nightOpen.set(k, false);
          nightOpen.set(key, open);
          nightRefresh();
          if (nightOpen.get(key)) document.querySelector(`[data-tool="${key}"]`)?.scrollIntoView({ block: "start" });
        } }, label))),
    nightOpen.get("room") ? h("div", { "data-tool": "room" }, roomPanel) : null,
    nightOpen.get("checkin") ? h("div", { "data-tool": "checkin" }, checkIn) : null,
    nightOpen.get("students") ? h("div", { "data-tool": "students" }, studentsPanel(p)) : null,
    nightOpen.get("where") ? h("section", { className: "panel", "data-tool": "where" }, h("h2", {}, "Where is…"), search, results) : null,
    nightOpen.get("share") ? h("div", { "data-tool": "share" }, sharePanel(p, current)) : null,
    nightOpen.get("log") ? panel("log", true, `What happened tonight (${ev.nightLog.length})`,
      ev.nightLog.length ? h("ul", {}, [...ev.nightLog].reverse().map((e) => h("li", {}, `${e.at}  ${e.text}`))) : h("p", { className: "help" }, "Nothing yet.")) : null,
    h("p", { className: "help" }, "Everything you do here is saved in this browser as you go."),
  ));
}

// ----------------------------------------------------------------------
// Page.
// ----------------------------------------------------------------------

const START_HERE = [
  "**1. Your tables.** The page opens with an example dinner so you can try everything first. For your own event, click **Start a blank event** in the sidebar, or fill in the **Hosts template** and **Fams template** and upload them. A Google Forms export works too.",
  "**2. Pairing rules (optional).** Add a rule when a host must meet a fam, must never meet one, only comes for some rounds, or stays at one table all night.",
  "**3. Find the schedule.** Click **Find the best schedule**. Read any warnings, and the **Before the night** checklist under the schedule.",
  "**4. Print.** Open and print the **seating chart**, **host cards**, **table tents**, and **run sheet** on US Letter. Then click **Mark as printed**.",
  "**5. Save.** Your work is kept in this browser as you go. Click **Save event file** in the sidebar too, and keep the file: it is the copy you can move to another computer or share. Open it again with **Open a saved event file**.",
  "**6. On the night.** Click **Open night mode** (under the schedule). It works on a phone: check the room setup, check people in, start and finish each round, and see who is where. When someone cancels, doesn't show, arrives late, or sits at the wrong table, tap it under **Someone changed?**, then **Update the schedule**. It tells you who to send where and which pages to reprint, and a QR code shows volunteers the schedule on their phones.",
  "**7. Next year.** Click **Hand off to next year** for a copy without student names, cancellations, or schedules. The README lists what happened on the night.",
];

const GLOSSARY: [string, string][] = [
  ["Host table", "one alum (or a pair) who hosts a topic, such as Pharmacy. Host tables move each round."],
  ["Alum", "the person hosting a host table. Their name is printed on host cards only."],
  ["Fam", "a group of admitted students seated at one numbered table all night."],
  ["Round", "one block of conversation. Between rounds every host moves to a new fam."],
  ["Tags and interests", "keywords for a host's topics and a fam's interests. Each tag they share raises the score."],
  ["Score", "how well a host matches a fam, from 0 (nothing shared) to 100 (the same keywords). The tool finds the schedule with the highest total score."],
  ["Weak round", "a round where a fam's host shares none of its interests, or no host comes to the fam."],
  ["Open table", "a fam with no host for a round, when there are more fams than host tables."],
  ["No table this round", "a host with no fam for a round, when there are more host tables than fams."],
  ["Pairing rule", "must meet, never meet, only in rounds, or stays with. Rules always hold; the score decides the rest."],
  ["Finished round", "a round that already happened. Re-planning never changes it."],
  ["Printed version", "the schedule you marked as printed. Changes are listed against it, so you reprint only what changed."],
  ["Event file", "the file Save event file downloads. It holds everything, and it is the copy to keep."],
];

function releaseDate(): string {
  const d = new Date(__RELEASE_DATE__ + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function renderShell(): void {
  const app = document.getElementById("app")!;
  const find = h("button", { id: "find", className: "button primary big", onclick: findSchedule }, "Find the best schedule");
  replace(app,
    h("aside", { id: "sidebar", "aria-label": "Event, saving, and spreadsheets" }),
    h("main", { id: "main" },
      h("div", { id: "top" }),
      h("h1", {}, "Rotation Optimizer"),
      h("p", { className: "lead" }, "Plan which host table visits which fam in each round of a rotation dinner. Fams stay seated; hosts move, and no fam meets the same host twice. The tool matches hosts to fams by shared interests, prints what you need for the night, and re-plans when someone cancels."),
      h("div", { id: "top-note" }),
      h("details", { open: !ev.plan, className: "guide" }, h("summary", {}, "Start here: how to plan a dinner in 7 steps"), START_HERE.map((p) => h("p", {}, rich(p)))),
      h("details", { className: "guide" }, h("summary", {}, "Words used here"),
        h("dl", {}, GLOSSARY.map(([t, d]) => [h("dt", {}, t), h("dd", {}, d)]))),
      h("div", { id: "upload-hosts" }),
      h("div", { id: "upload-fams" }),
      h("h2", {}, "1. Host tables"),
      h("p", { className: "help" }, "One row per host table. Tags are keywords separated by commas or semicolons. Blank tags are fine while a host has not replied. Type in the empty last row to add a host table; press Enter to move down. You can also copy rows from Google Sheets or Excel and paste them into a cell."),
      h("div", { id: "hosts-table" }),
      h("h2", {}, "2. Fams"),
      h("p", { className: "help" }, "One row per fam. Table # is the number on the table in the room; blank ones get the next free number. Students is optional, names separated by semicolons, for the find-your-table page. Location says where the table is in the room, and is printed on host cards so alumni find it. Step-free is yes for tables reachable without steps. You can paste rows copied from a spreadsheet."),
      h("div", { id: "fams-table" }),
      h("p", { id: "fam-totals", className: "help" }),
      h("h2", {}, "3. Pairing rules (optional)"),
      h("p", { className: "help" }, "must meet: the pair meets once, in one of the listed rounds (blank means any round). never meet: the pair never meets in the listed rounds (blank means never). only in rounds: the host comes only for the listed rounds; leave the fam blank. stays with: the alum stays at one fam's table all night instead of moving, for example if they cannot move between tables; leave the fam blank to let the tool choose, and leave Rounds blank. needs step-free: the alum only visits tables marked Step-free in the fams table; leave Fam and Rounds blank. Write rounds as 1 or 1, 2."),
      h("div", { id: "rules-table" }),
      h("p", { className: "help" }, "Your changes are checked as you type and kept in this browser."),
      h("div", { className: "row" }, find, h("span", { id: "find-status", className: "help" })),
      h("div", { id: "checks" }),
      h("section", { id: "schedule" }, h("h2", {}, "4. Schedule"), h("p", { className: "help" }, SCORE_LINE), h("div", { id: "schedule-body" })),
      h("div", { id: "checklist" }),
      h("section", { id: "night" }),
      h("footer", {},
        `Rotation Optimizer ${__VERSION__}, updated ${releaseDate()}. Everything runs in your browser: your event is saved on this computer as you work and is never sent anywhere. `,
        h("a", { href: "../" }, "About the project"), " · ",
        h("a", { href: "https://github.com/chrishoangle/rotation-optimizer" }, "Source code")),
    ),
  );
}

function renderTopNote(): void {
  const el = document.getElementById("top-note");
  if (!el) return;
  replace(el, practiceBanner(), ui.restored ? h("div", { className: "msg info row spread" }, ui.restored,
    h("button", { className: "button", onclick: () => { ui.restored = ""; renderTopNote(); } }, "OK")) : null, noteEl("top"));
}

function boot(): void {
  let restored = false;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      ev = loadEvent(saved.event);
      ui.savedHash = saved.savedHash ?? "";
      ui.savedAt = saved.savedAt ?? "";
      ui.restored = `Welcome back. Your event "${ev.title}" was restored from this browser${saved.at ? ` (last change at ${saved.at})` : ""}.`;
      restored = true;
    }
  } catch { /* nothing saved, or storage is blocked */ }
  if (!restored) {
    ev = practiceEvent();
    ui.savedHash = fileHash(ev);
  }
  let mode = "";
  try { mode = localStorage.getItem(MODE_KEY) ?? ""; } catch { /* the planning screen is the default */ }
  try { uiMode = localStorage.getItem(UI_KEY) === "full" ? "full" : "guided"; } catch { /* guided */ }
  // The full planner, with every option, is at the address ending in #full.
  if (location.hash === "#full") uiMode = "full";
  if (!restored && uiMode === "guided") ev = newEvent({ title: "", rounds: 2 }); // the guided start page offers the example instead
  if (mode === "night" && ev.plan) setNightMode(true);
  else showPlanner();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(() => {
      const el = document.getElementById("offline-status");
      if (el) el.textContent = "This page is saved on this device, so it opens and plans with no internet.";
    }).catch(() => { /* still works online */ });
  }
  getHighs().catch(() => {
    if (night.on) return; // night mode shows the error when a re-plan is tried
    note("checks", "error", "The schedule solver could not load. Check your internet connection and reload the page.");
    renderChecks();
  });
}

boot();
