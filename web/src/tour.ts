// A two-minute walkthrough of a whole dinner, from the lists to next year.
//
// It plays on a copy of the coordinator's own event when one is open, so
// they meet their own alumni and fams, or on an invented example dinner
// otherwise. Nothing it does touches the real event. Eight short scenes,
// each one picture and a line or two, with Back, Next, and Skip; the step
// is remembered, so closing the tab and coming back resumes where it was.

import { h, replace } from "./dom";
import type { EventState } from "./event";
import { loadEvent, newEvent, normalizeState, saveEvent } from "./event";
import { tableNumbers } from "./export";
import { avatars, famHue, peopleIn } from "./faces";
import { icon } from "./icons";
import { movesBetween } from "./moves";
import { cancelHost } from "./night";
import { hostSettings, setHostSettings, settingsWords } from "./people";
import type { EventPlan } from "./planning";
import { reprintList } from "./planning";

export interface TourCtx {
  /** The coordinator's event, if they have one with people in it. */
  mine(): EventState | null;
  /** Plan an event that is not the open one. Returns a problem in plain words, or "". */
  solveOn(s: EventState, keepPrinted: boolean): Promise<string>;
  now(): string;
  /** Leave the tour: "start" opens Set up for a new dinner, "back" returns to what was open. */
  finish(next: "start" | "back"): void;
}

const STEP_KEY = "rotation-optimizer:tour";
const SEEN_KEY = "rotation-optimizer:tour-seen";
const TITLES = ["Meet the event", "See the lists", "Build the schedule", "Why it works", "Print the event", "When something changes", "Run the night", "Wrap up"];

interface Tour {
  step: number;
  mode: "mine" | "example";
  ev: EventState;
  plan: EventPlan | null; // the schedule, made in scene 3
  built: boolean; // scene 3's checklist has finished once
  change: { who: string; round: number; after: EventPlan | null; problem: string } | null;
  nightRound: number; // the round shown in scene 7's phone, 0 until it is first shown
  told: Set<string>;
}

let ctx: TourCtx;
let t: Tour | null = null;
let root: HTMLElement | null = null;
let lastFocus: HTMLElement | null = null;

export const tourSeen = (): boolean => { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; } };
export const tourStep = (): number | null => {
  try { const n = Number(localStorage.getItem(STEP_KEY)); return n >= 1 && n <= TITLES.length ? n : null; } catch { return null; }
};
const remember = (n: number | null) => {
  try { if (n === null) localStorage.removeItem(STEP_KEY); else localStorage.setItem(STEP_KEY, String(n)); } catch { /* a convenience */ }
};

// ----------------------------------------------------------------------
// The example dinner: invented people, the size of a real one.
// ----------------------------------------------------------------------

const EXAMPLE_HOSTS: [string, string, string][] = [
  ["Medicine", "Dr. Alex Chen", "medicine; pre-med; biology"],
  ["Engineering", "Maya Ortiz & Sam Patel", "engineering; computer science"],
  ["Law", "Jordan Lee", "law; policy; history"],
  ["Public health", "Priya Nair", "public health; medicine; policy"],
  ["Finance", "Chris Johnson", "business; economics; finance"],
  ["Design", "Elena Rossi & Ben Carter", "design; art; film"],
  ["Education", "Dana Kim", "education; psychology"],
  ["Data", "Marcus Hall", "data; statistics; math"],
  ["Environment", "Rosa Delgado", "environment; policy; biology"],
];
const EXAMPLE_FAMS: [string, string][] = [
  ["Fam Gold", "medicine; pre-med; biology"], ["Fam Blue", "engineering; computer science; math"], ["Fam Red", "law; policy; history"],
  ["Fam Green", "environment; biology; policy"], ["Fam Teal", "business; economics"], ["Fam Pink", "psychology; education"],
  ["Fam Gray", "art; design; film"], ["Fam Navy", "data; statistics; math"],
];

function exampleDinner(): EventState {
  const s = newEvent({
    title: "Spring Alumni Dinner", rounds: 3,
    hosts: EXAMPLE_HOSTS.map(([table_label, host_name, tags]) => ({ table_label, host_name, tags })),
    fams: EXAMPLE_FAMS.map(([fam_label, interests], i) => ({ fam_label, interests, table_number: String(i + 1) })),
  });
  normalizeState(s);
  const late = s.hosts.find((r) => r.host_name === "Marcus Hall")!;
  setHostSettings(s, late.host_id, { ...hostSettings(s, late.host_id), from: 2 });
  return s;
}

// ----------------------------------------------------------------------
// Opening, moving between scenes, closing.
// ----------------------------------------------------------------------

export function openTour(c: TourCtx, fromStep?: number): void {
  ctx = c;
  lastFocus = document.activeElement as HTMLElement | null;
  const mine = ctx.mine();
  const ev = mine ? loadEvent(saveEvent(mine)) : exampleDinner();
  // The walkthrough starts the night fresh on its copy; the real event keeps its clock and notes.
  if (mine) { ev.finished = 0; ev.printed = null; ev.night = { ...ev.night, roundTimes: {}, told: [] }; }
  t = { step: fromStep ?? tourStep() ?? 1, mode: mine ? "mine" : "example", ev, plan: ev.plan, built: false, change: null, nightRound: 0, told: new Set() };
  root?.remove();
  root = h("div", { className: "c-tour-backdrop" });
  root.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Escape") { e.preventDefault(); close("back"); }
    if (k === "Tab") trapFocus(e as KeyboardEvent);
  });
  document.body.append(root);
  document.body.classList.add("c-touring");
  show(t.step);
}

function trapFocus(e: KeyboardEvent): void {
  const all = [...root!.querySelectorAll<HTMLElement>("button, [tabindex='0'], input")].filter((x) => !x.hasAttribute("disabled"));
  if (!all.length) return;
  const first = all[0], last = all[all.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function close(next: "start" | "back", done = false): void {
  if (done || next === "start") { remember(null); try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* fine */ } }
  else if (t) remember(t.step);
  root?.remove();
  root = null;
  t = null;
  document.body.classList.remove("c-touring");
  ctx.finish(next);
  lastFocus?.focus?.();
}

function show(step: number): void {
  if (!t || !root) return;
  t.step = Math.max(1, Math.min(TITLES.length, step));
  remember(t.step);
  const n = t.step;
  const last = n === TITLES.length;
  // Focusable, so a long scene on a small screen can be scrolled with the keyboard.
  const scene = h("div", { className: "c-tour-scene", "data-step": n, tabindex: 0, role: "group", "aria-labelledby": "c-tour-h" });
  replace(root, h("div", { className: "c-tour", role: "dialog", "aria-modal": "true", "aria-labelledby": "c-tour-h" },
    h("div", { className: "c-tour-top" },
      h("span", { className: "c-tour-count" }, `${n} of ${TITLES.length}`),
      h("ol", { className: "c-tour-dots", "aria-hidden": "true" }, TITLES.map((_, i) => h("li", { className: i + 1 < n ? "done" : i + 1 === n ? "now" : "" }))),
      h("button", { className: "c-link", "data-k": "tour-skip", onclick: () => close("back", true) }, "Skip tour")),
    scene,
    h("div", { className: "c-tour-nav" },
      n > 1 ? h("button", { className: "c-button", "data-k": "tour-back", onclick: () => show(n - 1) }, "Back") : h("span"),
      last ? h("div", { className: "c-row" },
        t.mode === "mine" ? null : h("button", { className: "c-button", onclick: () => close("back", true) }, "Close"),
        h("button", { className: "c-button primary big", "data-k": "tour-end", onclick: () => close(t!.mode === "mine" ? "back" : "start", true) },
          t.mode === "mine" ? "Back to my dinner" : "Plan my dinner"))
        : h("button", { className: "c-button primary big", "data-k": "tour-next", id: "c-tour-next", onclick: () => show(n + 1) }, "Next", icon("chevron")))));
  fill(scene, n);
  (root.querySelector("#c-tour-h") as HTMLElement | null)?.focus();
}

function fill(scene: HTMLElement, n: number): void {
  const scenes = [meet, lists, build, why, print, change, night, wrap];
  scenes[n - 1](scene);
}

// ----------------------------------------------------------------------
// Little pieces.
// ----------------------------------------------------------------------

const heading = (text: string) => h("h2", { id: "c-tour-h", tabindex: -1 }, text);
const line = (text: string) => h("p", { className: "c-tour-line" }, text);
const words = (t: string) => (t ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean);
const chip = (w: string, hot = false) => h("span", { className: `c-tour-chip ${hot ? "hot" : ""}` }, w);
const point = (glyph: Parameters<typeof icon>[0], text: string) => h("li", {}, icon(glyph), h("span", {}, text));
const hostsOf = (s: EventState) => s.hosts.filter((r) => (r.host_name || r.table_label || "").trim());
const famsOf = (s: EventState) => s.fams.filter((r) => (r.fam_label ?? "").trim());
const people = (s: EventState) => hostsOf(s).reduce((n, r) => n + Math.max(1, peopleIn(r.host_name || r.table_label).length), 0);
const who = (x: { person: string; name: string }) => x.person || x.name;
const shared = (p: EventPlan, hostId: string, famId: string) => {
  const host = p.hosts.find((x) => x.hostId === hostId)!;
  const fam = p.fams.find((f) => f.groupId === famId)!;
  return fam.interests.filter((w) => host.tags.includes(w));
};
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

async function ensurePlan(): Promise<string> {
  if (!t) return "";
  if (t.plan) return "";
  const problem = await ctx.solveOn(t.ev, false);
  if (!problem && t.ev.plan) t.plan = t.ev.plan;
  return problem;
}

// ----------------------------------------------------------------------
// 1. Meet the event.
// ----------------------------------------------------------------------

const ROOM = `<svg viewBox="0 0 320 120" aria-hidden="true" class="c-tour-room">
<g class="tbl"><circle cx="60" cy="60" r="30"/><circle cx="160" cy="60" r="30"/><circle cx="260" cy="60" r="30"/></g>
<g class="stu"><circle cx="40" cy="36" r="6"/><circle cx="80" cy="36" r="6"/><circle cx="40" cy="84" r="6"/><circle cx="140" cy="36" r="6"/><circle cx="180" cy="36" r="6"/><circle cx="140" cy="84" r="6"/><circle cx="240" cy="36" r="6"/><circle cx="280" cy="36" r="6"/><circle cx="240" cy="84" r="6"/></g>
<circle class="alum a1" cx="80" cy="84" r="9"/><circle class="alum a2" cx="180" cy="84" r="9"/><circle class="alum a3" cx="280" cy="84" r="9"/></svg>`;

function meet(scene: HTMLElement): void {
  const s = t!.ev;
  const pic = h("div", { className: "c-tour-pic" });
  pic.innerHTML = ROOM;
  replace(scene,
    h("p", { className: "c-tour-kicker" }, t!.mode === "mine" ? "Let's walk through your event." : "Here's an example alumni dinner."),
    heading(`Welcome to ${s.title || "your dinner"}`),
    h("div", { className: "c-tour-stats" },
      h("div", {}, h("strong", {}, String(people(s))), h("span", {}, "alumni")),
      h("div", {}, h("strong", {}, String(famsOf(s).length)), h("span", {}, "fams")),
      h("div", {}, h("strong", {}, String(s.rounds)), h("span", {}, s.rounds === 1 ? "round" : "rounds"))),
    pic,
    h("ul", { className: "c-tour-points" },
      point("table", "Students stay seated at their fam's table."),
      point("people", "Alumni, alone or in pairs, move to a new table each round."),
      point("sparkle", "Every fam meets alumni who share its interests.")));
}

// ----------------------------------------------------------------------
// 2. The lists.
// ----------------------------------------------------------------------

function lists(scene: HTMLElement): void {
  const s = t!.ev;
  const hosts = hostsOf(s).slice(0, 4), fams = famsOf(s).slice(0, 4);
  const more = (n: number, what: string) => (n > 0 ? h("li", { className: "c-tour-more" }, `and ${n} more ${what}`) : null);
  replace(scene,
    heading("Two lists are all it needs"),
    line("Most coordinators paste these from a spreadsheet or a sign-up form."),
    h("div", { className: "c-tour-lists" },
      h("section", { className: "c-tour-card" }, h("h3", {}, icon("people"), "Alumni"),
        h("ul", {}, hosts.map((r, i) => {
          const name = r.host_name || r.table_label;
          const when = settingsWords(s, r.host_id).filter((w) => /round|arrive|leave/i.test(w));
          return h("li", { style: `--i: ${i}` }, avatars(name),
            h("span", { className: "c-tour-row" }, h("strong", { className: "c-tour-name" }, name),
              h("span", { className: "c-tour-chips" }, words(r.tags).slice(0, 3).map((w) => chip(w)), when.map((w) => h("span", { className: "c-tour-chip when" }, w)))));
        }), more(hostsOf(s).length - hosts.length, "tables"))),
      h("section", { className: "c-tour-card" }, h("h3", {}, icon("table"), "Fams"),
        h("ul", {}, fams.map((r, i) => h("li", { style: `--i: ${i + 4}` },
          h("span", { className: "c-tour-disc", style: `--h: ${famHue(i + 1)}`, "aria-hidden": "true" }, String(i + 1)),
          h("span", { className: "c-tour-row" }, h("strong", { className: "c-tour-name" }, r.fam_label),
            h("span", { className: "c-tour-chips" }, words(r.interests).slice(0, 3).map((w) => chip(w)))))),
          more(famsOf(s).length - fams.length, "fams")))),
    h("ul", { className: "c-tour-legend", "aria-label": "What the app reads" },
      h("li", {}, h("span", { className: "c-tour-key name" }), "Names"),
      h("li", {}, h("span", { className: "c-tour-key chip" }), "Interests"),
      h("li", {}, h("span", { className: "c-tour-key when" }), "Who is here when")));
}

// ----------------------------------------------------------------------
// 3. Build the schedule.
// ----------------------------------------------------------------------

function build(scene: HTMLElement): void {
  const tasks = ["Matching interests", "Avoiding repeat visits", "Checking who is here when", "Getting the printouts ready"];
  const list = h("ol", { className: "c-tour-tasks" }, tasks.map((x) => h("li", {}, h("span", { className: "c-tour-tick", "aria-hidden": "true" }), x)));
  const end = h("div", { className: "c-tour-ready", role: "status" });
  const next = document.getElementById("c-tour-next") as HTMLButtonElement | null;
  replace(scene, heading("Build the schedule"), line("One tap. The app seats every alum, every round."), list, end);
  const finish = (problem: string) => {
    if (problem) { replace(end, h("p", { className: "c-msg warn" }, `The schedule could not be made yet: ${problem} You can still see how the rest works.`)); return; }
    replace(end, h("span", { className: "c-tour-done", "aria-hidden": "true" }, icon("check")), h("strong", {}, "Schedule ready."));
  };
  if (t!.built) {
    list.querySelectorAll("li").forEach((li) => li.classList.add("done"));
    finish(t!.plan ? "" : "the lists need a look in Set up.");
    return;
  }
  if (next) next.disabled = true;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const pace = reduce ? 80 : 520;
  const solving = ensurePlan();
  const step = t!.step;
  tasks.forEach((_, i) => setTimeout(() => {
    if (!t || t.step !== step) return;
    list.children[i]?.classList.add("done");
    if (i === tasks.length - 1) solving.then((problem) => {
      if (!t || t.step !== step) return;
      t.built = true;
      finish(problem);
      if (next) { next.disabled = false; next.focus(); }
    });
  }, pace * (i + 1)));
}

// ----------------------------------------------------------------------
// 4. Why it works.
// ----------------------------------------------------------------------

async function why(scene: HTMLElement): Promise<void> {
  replace(scene, heading("Why it works"), line("Preparing…"));
  const problem = await ensurePlan();
  const p = t?.plan;
  if (!p || problem) { replace(scene, heading("Why it works"), line("Once your lists are complete, this shows who meets whom and why.")); return; }
  const tables = tableNumbers(p);
  const used = new Set<string>(), usedHosts = new Set<string>();
  const best = [...p.assignments].map((a) => ({ a, w: shared(p, a.hostId, a.groupId) }))
    .sort((x, y) => y.w.length - x.w.length || x.a.round - y.a.round)
    .filter(({ a, w }) => w.length && !used.has(a.groupId) && !usedHosts.has(a.hostId) && (used.add(a.groupId), usedHosts.add(a.hostId), true))
    .slice(0, 3);
  const fam = best[0]?.a.groupId ?? p.fams[0]?.groupId;
  const night = Array.from({ length: p.rounds }, (_, k) => k + 1).map((r) => {
    const a = p.assignments.find((x) => x.round === r && x.groupId === fam);
    const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
    return h("li", {}, h("span", { className: "c-tour-round" }, `Round ${r}`), host ? avatars(who(host)) : h("span", { className: "c-tour-empty" }, "·"), h("span", {}, host ? who(host) : "a quiet round"));
  });
  const famName = p.fams.find((f) => f.groupId === fam)?.name ?? "";
  replace(scene,
    heading("Why it works"),
    h("ul", { className: "c-tour-matches" }, best.map(({ a, w }, i) => {
      const host = p.hosts.find((x) => x.hostId === a.hostId)!;
      const f = p.fams.find((x) => x.groupId === a.groupId)!;
      return h("li", { style: `--i: ${i}` },
        h("span", { className: "c-tour-disc", style: `--h: ${famHue(tables[f.groupId])}`, "aria-hidden": "true" }, String(tables[f.groupId])),
        h("span", { className: "c-tour-row" },
          h("span", {}, h("strong", {}, f.name), " meets ", h("strong", {}, who(host)), ` because they share ${andList(w.slice(0, 3))}.`),
          h("span", { className: "c-tour-chips" }, w.slice(0, 3).map((x) => chip(x, true)))),
        avatars(who(host)));
    })),
    h("div", { className: "c-tour-card c-tour-night" }, h("h3", {}, `${famName}'s night`), h("ol", {}, night)),
    h("ul", { className: "c-tour-badges" },
      h("li", {}, icon("check"), "No fam meets anyone twice"),
      h("li", {}, icon("swap"), "Different alumni each round"),
      h("li", {}, icon("sparkle"), "Strongest matches first")));
}

// ----------------------------------------------------------------------
// 5. Print the event.
// ----------------------------------------------------------------------

function print(scene: HTMLElement): void {
  const s = t!.ev;
  const nHosts = hostsOf(s).length, nFams = famsOf(s).length;
  const doc = (title: string, sub: string, i: number) => h("li", { style: `--i: ${i}` },
    h("span", { className: "c-tour-paper", "aria-hidden": "true" }, h("span"), h("span"), h("span"), h("span")),
    h("strong", {}, title), h("span", { className: "c-help" }, sub));
  replace(scene,
    heading("Print the event"),
    line("Everything comes from one schedule."),
    h("ul", { className: "c-tour-docs" },
      doc("Room chart", "who sits where, each round", 0),
      doc("Alumni cards", `${nHosts}, one for each alum or pair`, 1),
      doc("Table numbers", `${nFams}, one for each fam`, 2),
      doc("Run sheet", "the night, minute by minute", 3)),
    h("p", { className: "c-tour-callout" }, icon("printer"), "If the schedule changes, the app knows exactly which pages to reprint."));
}

// ----------------------------------------------------------------------
// 6. When something changes.
// ----------------------------------------------------------------------

async function change(scene: HTMLElement): Promise<void> {
  replace(scene, heading("When something changes"), line("Preparing…"));
  const problem = await ensurePlan();
  const p = t?.plan;
  if (!t || !p || problem) { replace(scene, heading("When something changes"), line("Once your schedule is made, this shows how a cancellation is handled.")); return; }
  const round = p.rounds >= 2 ? 2 : 1;
  if (!t.change) {
    // Someone who hosts in that round, preferably alone, so the story is simple.
    const inRound = p.assignments.filter((a) => a.round === round).map((a) => p.hosts.find((x) => x.hostId === a.hostId)!);
    const solo = inRound.find((x) => who(x) === "Chris Johnson") ?? inRound.find((x) => peopleIn(who(x)).length === 1) ?? inRound[0];
    t.change = { who: solo ? who(solo) : "", round, after: null, problem: "" };
    if (solo) {
      const copy = loadEvent(saveEvent(t.ev));
      copy.plan = p;
      copy.printed = p;
      copy.finished = round - 1;
      cancelHost(copy, solo.hostId, round, ctx.now());
      t.change.problem = await ctx.solveOn(copy, true);
      t.change.after = copy.plan !== p ? copy.plan : null;
    }
    if (!t || !root || t.step !== 6) return;
  }
  const c = t.change!;
  const moves = c.after ? movesBetween(p, c.after, round) : null;
  const out = c.after ? reprintList(p, c.after) : null;
  const pages = out ? [
    out.hostIds.length ? `${out.hostIds.length} alumni card${out.hostIds.length !== 1 ? "s" : ""}` : "",
    out.famIds.length ? `${out.famIds.length} table number${out.famIds.length !== 1 ? "s" : ""}` : "",
    out.seatingRounds.length ? `the room chart for round${out.seatingRounds.length !== 1 ? "s" : ""} ${andList(out.seatingRounds.map(String))}` : "",
  ].filter(Boolean) : [];
  const n = moves ? moves.hosts.length + moves.fams.length : 0;
  replace(scene,
    heading("When something changes"),
    h("div", { className: "c-tour-card c-tour-cancel" }, avatars(c.who), h("strong", {}, `${c.who} can't make round ${round}.`)),
    h("ol", { className: "c-tour-flow" },
      h("li", { style: "--i: 0" }, icon("bell"), round > 1 ? `Round 1 is done, so it stays exactly as it was.` : "Nothing has started yet."),
      h("li", { style: "--i: 1" }, icon("swap"), c.after ? `The app re-plans from round ${round}, moving as few people as it can.` : c.problem || "Nobody else needs to move."),
      h("li", { style: "--i: 2" }, icon("people"), n ? `${n === 1 ? "One person needs" : `${n} people need`} telling. Everyone else stays put.` : "Nobody else moves."),
      h("li", { style: "--i: 3" }, icon("printer"), pages.length ? `Reprint only ${andList(pages)}.` : "Nothing needs reprinting.")),
    h("p", { className: "c-tour-callout" }, icon("sparkle"), "In a spreadsheet, one cancellation means re-checking every row by hand. Here it takes one tap."));
}

// ----------------------------------------------------------------------
// 7. Run the night.
// ----------------------------------------------------------------------

function night(scene: HTMLElement): void {
  const p = t?.change?.after ?? t?.plan;
  if (!t || !p) { replace(scene, heading("Run the night"), line("On the night, your phone shows the round, the clock, and who to tell.")); return; }
  // Start where the change bites, so the "tell these people" list is the first thing seen.
  if (!t.nightRound) t.nightRound = t.change?.after ? t.change.round : 1;
  const r = Math.min(t.nightRound, p.rounds);
  const tables = tableNumbers(p);
  const m = t.change?.after && t.plan ? movesBetween(t.plan, t.change.after, t.change.round) : null;
  const moves = m ? [...m.hosts, ...m.fams].slice(0, 3) : [];
  const where = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]).slice(0, 3).map((f) => {
    const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
    const host = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
    return h("li", {}, h("span", { className: "c-tour-disc small", style: `--h: ${famHue(tables[f.groupId])}`, "aria-hidden": "true" }, String(tables[f.groupId])),
      h("span", {}, f.name), h("span", { className: "c-tour-who" }, host ? who(host) : "no alum"));
  });
  const phone = h("div", { className: "c-tour-phone" },
    h("p", { className: "c-tour-phone-round" }, `Round ${r} of ${p.rounds}`),
    h("div", { className: "c-tour-ring", "aria-hidden": "true" }, h("span", {}, "14"), h("small", {}, "minutes left")),
    h("button", { className: "c-button primary wide", "data-k": "tour-end-round", onclick: () => { if (r < p.rounds) { t!.nightRound = r + 1; show(7); } else show(8); } }, r < p.rounds ? `End round ${r}` : "End the last round"),
    moves.length && r >= (t.change?.round ?? 2) ? h("div", { className: "c-tour-tell" }, h("strong", {}, "Tell these people where to go"),
      h("ul", {}, moves.map((m, i) => {
        const key = `${i}`;
        const box = h("input", { type: "checkbox", checked: t!.told.has(key), "aria-label": `Told: ${m.text}` }) as HTMLInputElement;
        box.addEventListener("change", () => { if (box.checked) t!.told.add(key); else t!.told.delete(key); box.closest("li")?.classList.toggle("told", box.checked); });
        return h("li", { className: t!.told.has(key) ? "told" : "" }, h("label", {}, box, h("span", {}, m.text.replace(/\bhost\b/g, "alum"))));
      }))) : null,
    h("div", { className: "c-tour-where" }, h("strong", {}, "Who is where"), h("ul", {}, where)));
  replace(scene,
    heading("Run the night"),
    line(moves.length && r >= (t.change?.round ?? 2) ? `Round ${r - 1 || 1} is over. Not the whole schedule: just the people who need to hear something.` : "Tap End round to move on. The phone tells you who to send where."),
    phone);
}

// ----------------------------------------------------------------------
// 8. Wrap up.
// ----------------------------------------------------------------------

function wrap(scene: HTMLElement): void {
  replace(scene,
    h("span", { className: "c-tour-done big", "aria-hidden": "true" }, icon("check")),
    heading("Event complete"),
    h("ul", { className: "c-tour-points" },
      point("calendar", "Save a note for next year: what worked, which table was loud."),
      point("folder", "Save next year's setup as one file. Next year starts from this year, not a blank sheet."),
      point("people", "Remove student names when the night is over, if your office asks.")),
    h("p", { className: "c-tour-callout" }, icon("sparkle"), t!.mode === "mine" ? "That's the whole night. Your dinner is right where you left it." : "That's the whole night. Ready to plan yours?"));
}
