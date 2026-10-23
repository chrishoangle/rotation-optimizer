// Pages for the people around the coordinator: a two-page guide, cards for
// volunteers, a paper backup of the whole schedule, a plan summary for a
// director, and a privacy note for IT. Volunteers change every year, so
// these replace a training meeting.

import { sharedPairings } from "./explain";
import { hostViewRows, scheduleRows, tableNumbers } from "./export";
import { EventPlan, hostLabel, provenOptimal } from "./planning";
import type { EventState } from "./event";
import { htmlEscape as e } from "./py";
import { SWITCH, plannedStart, shown, status, toMinutes } from "./timing";

const APP_URL = "https://chrishoangle.github.io/rotation-optimizer/app/";

function page(title: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>
@page { size: letter; margin: 0.6in; }
* { box-sizing: border-box; }
body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; margin: 0; }
@media screen { body { margin: 24px; max-width: 8in; } }
h1 { font-size: 22px; margin: 0 0 6px; } h2 { font-size: 17px; margin: 18px 0 6px; } h3 { font-size: 15px; margin: 12px 0 4px; }
p, li { margin: 4px 0; } ol, ul { padding-left: 20px; margin: 4px 0; }
.meta { color: #5c5c63; }
.break { break-before: page; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin: 6px 0 12px; }
th, td { text-align: left; border-bottom: 1px solid #d9d6cf; padding: 4px 6px; vertical-align: top; }
th { color: #5c5c63; font-weight: 600; }
.if { break-inside: avoid; margin: 8px 0; }
.if strong { display: block; }
${extraCss}
</style></head><body>
${body}
</body></html>
`;
}

/** Two pages: planning in steps, then "on the night, if this happens, do this". */
export function coordinatorGuideHtml(title: string): string {
  const ifs: [string, string][] = [
    ["An alum doesn't show up, or has to leave", "Run, Someone changed?, An alum left or didn't come. Choose them and the first round they miss, then Work out who moves. Tell the people listed."],
    ["An alum arrives late, or someone new comes", "Someone changed?, An alum arrived late, or someone new came. Choose them, or Someone not on the list, and the round they start."],
    ["Students sit at the wrong table", "Don't move the students. Someone changed?, A fam is sitting at a different table: type the number they are at. The alumni come to them."],
    ["A whole fam leaves", "Someone changed?, A whole fam left."],
    ["A student walks in", "Nothing to change: they join any fam with space."],
    ["The laptop or wifi dies", "Run the night from the printed seating chart. The app also works offline on any device that opened it before."],
  ];
  return page(`${title}: coordinator guide`, `
<h1>${e(title)}: coordinator guide</h1>
<p class="meta">Rotation Dinner, ${e(APP_URL)}. Students stay at their table all night; alumni move each round.</p>
<h2>Before the night</h2>
<ol>
<li><strong>Set up.</strong> Paste your alumni (name, then what they can talk about) and your fams (name, then interests) from your spreadsheet. Anyone arriving late or who can't use stairs goes under More options.</li>
<li><strong>Schedule.</strong> Make the schedule and read it as a room plan. To swap two alumni, tap Adjust, then tap one and another in the same round.</li>
<li><strong>Print.</strong> Print everything: room chart, alumni cards, table numbers, and run sheet in one file.</li>
</ol>
<h2>On the night: if this happens, do this</h2>
<p>Open <strong>Run</strong> on your phone. Tap <strong>Start round 1</strong>, and <strong>End round</strong> when each round ends. When something changes, tap <strong>Someone changed?</strong>; the app works out who moves and lists exactly who to tell.</p>
${ifs.map(([when, what]) => `<div class="if"><strong>${e(when)}</strong>${e(what)}</div>`).join("\n")}
<h2>After the night</h2>
<p>Choose Wrap up, jot what you'd change, then Save for next year and pass the file on.</p>
`);
}

/** Half a page per volunteer role. */
export function roleCardsHtml(title: string): string {
  const roles: [string, string[]][] = [
    ["Check-in (door)", [
      "Greet alumni and send students to sit with their fam. Students stay at that table all night.",
      "Tell the coordinator each alum who arrives, or tick them in night mode, Check-in.",
      "Count students into each fam in night mode, Students, so short fams show up early.",
      "At the start of round 1, tell the coordinator who has not arrived.",
      "A student without a fam: point them to the find-your-table page, or any fam with space.",
    ]],
    ["Runner", [
      "Move alumni between rounds. Each alum's host card and badge say their table for every round. Your runner sheet lists who arrives at your tables.",
      "Scan the coordinator's QR code to see who is where on your phone.",
      "When the coordinator re-plans, hand out the change slips, or tell each alum the sentence on the page.",
      "Keep spare host cards and the seating chart with you.",
      "If an alum is lost, ask the coordinator to search Where is in night mode.",
    ]],
    ["MC", [
      "Use the run sheet for timing. Announce each round when the coordinator says go.",
      "Read out the lines under For the MC to read out when the schedule changes.",
      "Say clearly: students stay seated, alumni move.",
    ]],
    ["Floater", [
      "Sit with any fam that has no host for a round (the seating chart shows Open table).",
      "Help the runner find alumni between rounds.",
      "Take photos only if the event allows it.",
    ]],
  ];
  const cards = roles.map(([role, lines]) => `<div class="role"><p class="event">${e(title)}</p><h2>${e(role)}</h2><ul>${lines.map((l) => `<li>${e(l)}</li>`).join("")}</ul><p class="ask">Questions: ask the coordinator.</p></div>`).join("\n");
  return page(`${title}: volunteer role cards`, `<div class="roles">${cards}</div>`, `
.roles { display: grid; grid-template-columns: 1fr; gap: 0.25in; }
.role { border: 2px dashed #8a8780; border-radius: 10px; padding: 12px 16px; min-height: 4.4in; break-inside: avoid; }
.role h2 { font-size: 24px; margin: 2px 0 8px; } .role li { font-size: 15px; margin: 6px 0; }
.event { color: #5c5c63; margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; } .ask { color: #5c5c63; margin-top: 10px; }
`);
}

/** The whole schedule on paper: every round, every host, and how to run the night without a device. */
export function backupPacketHtml(p: EventPlan, title: string, printedAt: string): string {
  const rounds = Array.from({ length: p.rounds }, (_, i) => i + 1);
  const rows = scheduleRows(p);
  const roundTables = rounds.map((r) => `<h2>Round ${r}</h2><table><tr><th>Table</th><th>Fam</th><th>Host table</th></tr>${rows.filter((x) => x.round === r).map((x) => `<tr><td>${x.table}</td><td>${e(x.fam)}</td><td>${e(String(x.host_table))}</td></tr>`).join("")}</table>`).join("");
  const hv = hostViewRows(p);
  const cols = hv.length ? Object.keys(hv[0]) : [];
  const names: Record<string, string> = { host_table: "Host table", host_name: "Alum" };
  const hostTable = `<table><tr>${cols.map((c) => `<th>${e(names[c] ?? c[0].toUpperCase() + c.slice(1))}</th>`).join("")}</tr>${hv.map((r) => `<tr>${cols.map((c) => `<td>${e(r[c])}</td>`).join("")}</tr>`).join("")}</table>`;
  return page(`${title}: backup packet`, `
<h1>${e(title)}: backup packet</h1>
<p class="meta">The whole schedule on paper${printedAt ? `, as printed at ${e(printedAt)}` : ""}. Keep this with the coordinator in case every device fails.</p>
<h2>Running the night from this packet</h2>
<ol>
<li>Students stay seated all night. Alumni move to the table listed for each round.</li>
<li>If an alum is missing, their fam has no host that round. Send a floater, or ask a nearby host table to share.</li>
<li>Do not re-plan by hand. Note changes on this page, and update the tool when a device is back.</li>
</ol>
<h2 class="break">Where each alum goes</h2>
${hostTable}
<div class="break"></div>
${roundTables}
`);
}

/** One or two pages for a director: the numbers, the rules, the notes, and every pairing. */
export function planSummaryHtml(p: EventPlan, title: string, rulesText: string[], notes: string): string {
  const [shared, all] = sharedPairings(p);
  const fairness = p.warnings.filter((w) => w.startsWith("Fairness check")).map((w) => w.replace(/^Fairness check: /, ""));
  const rows = scheduleRows(p);
  const rounds = Array.from({ length: p.rounds }, (_, i) => i + 1);
  return page(`${title}: plan summary`, `
<h1>${e(title)}: plan summary</h1>
<p class="meta">${p.fams.length} fams, ${p.hosts.length} host tables, ${p.rounds} round${p.rounds !== 1 ? "s" : ""}. Made with Rotation Optimizer.</p>
<h2>How good is the plan</h2>
<ul>
<li>${shared} of ${all} pairings share at least one interest.</li>
<li>${provenOptimal(p) ? "Proven best possible: no other schedule with these tables and rules scores higher." : "Not proven best possible: the solver stopped early."}</li>
<li>No fam meets the same alum twice.</li>
</ul>
<h2>Rules the plan follows</h2>
${rulesText.length ? `<ul>${rulesText.map((r) => `<li>${e(r)}</li>`).join("")}</ul>` : "<p>None. Pairings are by shared interests only.</p>"}
<h2>Things to know</h2>
${fairness.length ? `<ul>${fairness.map((f) => `<li>${e(f)}</li>`).join("")}</ul>` : "<p>Every fam gets a fair share of matching hosts, and every host table gets a fam.</p>"}
${notes.trim() ? `<h2>Coordinator notes</h2><p>${e(notes.trim())}</p>` : ""}
<h2>Every pairing</h2>
<table><tr><th>Table</th><th>Fam</th>${rounds.map((r) => `<th>Round ${r}</th>`).join("")}</tr>
${[...new Set(rows.map((x) => x.table))].map((t) => {
  const mine = rows.filter((x) => x.table === t);
  return `<tr><td>${t}</td><td>${e(mine[0].fam)}</td>${rounds.map((r) => { const x = mine.find((y) => y.round === r); return `<td>${x ? e(String(x.host_table)) : ""}${x && x.score === 0 ? " *" : ""}</td>`; }).join("")}</tr>`;
}).join("")}
</table>
<p class="meta">* shares no interest with the fam, or no host that round.</p>
`);
}

/** For IT or a supervisor who asks where the data goes. */
export function privacyNoteHtml(): string {
  return page("Rotation Optimizer: privacy note", `
<h1>Rotation Optimizer: where the data goes</h1>
<p class="meta">${e(APP_URL)}. Free and open source: https://github.com/chrishoangle/rotation-optimizer</p>
<h2>In short</h2>
<p>Nothing typed or uploaded into Rotation Optimizer is sent anywhere. The page, the schedule solver, and the printouts all run inside the browser on the coordinator's computer. There is no account, no server database, and no analytics.</p>
<h2>What is stored, and where</h2>
<ul>
<li><strong>In the browser.</strong> The current event and the last twelve versions are kept in this browser's local storage on this computer, so work survives a reload. Clearing the browser's site data removes them.</li>
<li><strong>In files the coordinator saves.</strong> Save event file, Mark as printed, and Hand off to next year download files to the computer. They go wherever the coordinator puts them.</li>
<li><strong>Offline copy.</strong> After one visit the browser keeps the page's own files (not event data) so it opens without internet.</li>
</ul>
<h2>Personal information</h2>
<ul>
<li>Uploads keep only the columns the coordinator picks. Email, phone, and timestamp columns from forms are always dropped.</li>
<li>Student names are optional; they are used only for the find-your-table page. Remove student names in the sidebar deletes them from the event.</li>
<li>Hand off to next year removes student names, check-in, cancellations, and schedules.</li>
<li>The Google Forms the tool can create live in the coordinator's own Google account and do not collect email addresses.</li>
</ul>
<h2>Network</h2>
<p>The page loads its own files from GitHub Pages. It makes no other network requests. The offline copy makes none at all.</p>
<h2>The volunteer QR code</h2>
<p>Night mode can show a QR code so volunteers see who is where. The schedule is packed into the link itself, after the # sign, which browsers never send to any server. It holds host table names, alumni names, fam names, and table locations, never student names. Anyone who has the link can read that schedule, so show it only to your volunteers.</p>
`);
}

export interface SetupRow { table: number; fam: string; location: string; stepFree: boolean; students: number }

/** A walk-the-room sheet: tick each table once its tent is on it, before doors open. */
export function setupSheetHtml(rows: SetupRow[], title: string): string {
  const sorted = [...rows].sort((a, b) => a.table - b.table);
  return page(`${title}: room setup`, `
<h1>${e(title)}: room setup</h1>
<p class="meta">Do this before doors open, so students sit at the right table. If students are already seated, do not move them: find which table each fam is at, then use night mode, A fam is at a different table.</p>
<ol>
<li>Put each table tent on its table. The tent shows the table number and the fam name.</li>
<li>Walk the room with this sheet. Tick a table when the right tent is on it and the table is where it says.</li>
<li>Check that the step-free tables can be reached without steps.</li>
<li>In night mode, tap Check for each table, so the tool knows the room is ready.</li>
</ol>
<table><tr><th>Done</th><th>Table</th><th>Fam</th><th>Where</th><th>Step-free</th><th>Students</th></tr>
${sorted.map((r) => `<tr><td class="box"></td><td><b>${r.table}</b></td><td>${e(r.fam)}</td><td>${e(r.location)}</td><td>${r.stepFree ? "Yes" : ""}</td><td>${r.students || ""}</td></tr>`).join("\n")}
</table>
`, ".box { width: 28px; } td.box::before { content: ''; display: inline-block; width: 14px; height: 14px; border: 1.5px solid #1c1c1e; }");
}

/** For the MC: when to call each remaining round, from where the night really is. */
export function mcCueCardHtml(s: EventState, p: EventPlan, now: number): string {
  const st = status(s, now);
  const len = st.catchUp ?? s.roundMinutes;
  const rows: string[] = [];
  let t = st.phase === "during" ? toMinutes(s.night.roundTimes?.[String(st.round)]?.start ?? "") ?? now : Math.max(now, plannedStart(s, st.round) ?? now);
  for (let r = st.round; r <= p.rounds; r++) {
    const say = r === 1 ? "Alumni, go to the table on your card for round 1." : `Thank your table. Alumni, move to the table on your card for round ${r}.`;
    const started = st.phase === "during" && r === st.round;
    rows.push(`<tr><td class="t">${started ? "now" : e(shown(t))}</td><td><b>Round ${r}</b>${started ? " (under way)" : ""}</td><td>${started ? "" : e(say)}</td></tr>`);
    rows.push(`<tr><td class="t">${e(shown(t + len))}</td><td>End of round ${r}</td><td>${r < p.rounds ? "Ask hosts to say goodbye; they move in a minute." : "Thank the hosts and the fams. Closing."}</td></tr>`);
    t += len + SWITCH;
  }
  return page(`${s.title}: MC cue card`, `
<h1>${e(s.title)}: MC cue card</h1>
<p class="meta">Printed at ${e(shown(now))}. ${st.lateBy >= 5 ? `Running ${st.lateBy} minutes late. ` : ""}${st.catchUp ? `Rounds shortened to ${len} minutes to finish on time.` : `Rounds are ${len} minutes, with ${SWITCH} minutes to move.`}</p>
<table class="cues">${rows.join("\n")}</table>
<p class="meta">Students stay seated all night. Alumni move.</p>
`, ".cues td { font-size: 16px; padding: 8px; } .cues .t { font-weight: 800; white-space: nowrap; width: 1.2in; }");
}

/**
 * Split the tables between runners: by location when tables have one (so a
 * runner keeps to one part of the room), otherwise in number order.
 */
export function runnerGroups(p: EventPlan, runners: number, locations: Record<string, string>): string[][] {
  const tables = tableNumbers(p);
  const fams = [...p.fams].sort((a, b) => (locations[a.groupId] ?? "").localeCompare(locations[b.groupId] ?? "") || tables[a.groupId] - tables[b.groupId]);
  const n = Math.max(1, Math.min(runners, fams.length));
  const size = Math.ceil(fams.length / n);
  return Array.from({ length: n }, (_, i) => fams.slice(i * size, (i + 1) * size).map((f) => f.groupId)).filter((g) => g.length);
}

/** One page per runner: their tables, and for each round who walks to them and from where. */
export function runnerSheetsHtml(p: EventPlan, title: string, runners: number, locations: Record<string, string>): string {
  const tables = tableNumbers(p);
  const famName = (id: string) => p.fams.find((f) => f.groupId === id)!.name;
  const label = (hostId: string) => { const x = p.hosts.find((y) => y.hostId === hostId)!; return hostLabel(x); };
  const pages = runnerGroups(p, runners, locations).map((group, i) => {
    const mine = new Set(group);
    const list = group.map((id) => `Table ${tables[id]} ${famName(id)}` + (locations[id] ? ` (${locations[id]})` : "")).join("; ");
    const rounds = Array.from({ length: p.rounds }, (_, k) => k + 1).map((r) => {
      const rows = p.assignments.filter((a) => a.round === r && mine.has(a.groupId))
        .sort((a, b) => tables[a.groupId] - tables[b.groupId])
        .map((a) => {
          const prev = r > 1 ? p.assignments.find((x) => x.round === r - 1 && x.hostId === a.hostId) : undefined;
          const from = r === 1 ? "check-in" : prev ? `Table ${tables[prev.groupId]}` : "no table";
          return `<tr><td class="box"></td><td><b>Table ${tables[a.groupId]}</b></td><td>${e(label(a.hostId))}</td><td>from ${e(from)}</td></tr>`;
        });
      const empty = group.filter((id) => !p.assignments.some((a) => a.round === r && a.groupId === id) && !(p.famAway[id] ?? []).includes(r));
      return `<h3>Round ${r}</h3><table><tr><th></th><th>Table</th><th>Host arriving</th><th></th></tr>${rows.join("")}</table>` +
        (empty.length ? `<p class="meta">No host this round at ${empty.map((id) => `Table ${tables[id]}`).join(", ")}: send a floater.</p>` : "");
    }).join("");
    return `<section class="${i ? "break" : ""}"><h1>${e(title)}: runner ${i + 1} of ${runners}</h1><p class="meta">Your tables: ${e(list)}.</p>
<p>Before each round, check that each host below reaches your table. Tick them off. If someone is missing, tell the coordinator.</p>${rounds}</section>`;
  });
  return page(`${title}: runner sheets`, pages.join("\n"), ".box { width: 28px; } td.box::before { content: ''; display: inline-block; width: 14px; height: 14px; border: 1.5px solid #1c1c1e; }");
}

/** Credit-card sized badges for alumni: their table for every round, to slip behind a name badge. */
export function hostBadgesHtml(p: EventPlan, title: string, locations: Record<string, string>): string {
  const tables = tableNumbers(p);
  const badges = p.hosts.map((x) => {
    const rows = Array.from({ length: p.rounds }, (_, k) => k + 1).map((r) => {
      const a = p.assignments.find((y) => y.round === r && y.hostId === x.hostId);
      const f = a ? p.fams.find((y) => y.groupId === a.groupId)! : null;
      const what = f ? `<b>Table ${tables[f.groupId]}</b> ${e(f.name)}${locations[f.groupId] ? ` <i>${e(locations[f.groupId])}</i>` : ""}`
        : (p.hostAway[x.hostId] ?? []).includes(r) ? "Cancelled" : (p.hostLimits[x.hostId] ?? []).includes(r) ? "Not hosting" : "Break";
      return `<div class="r"><span>Round ${r}</span>${what}</div>`;
    }).join("");
    return `<div class="badge"><div class="ev">${e(title)}</div><div class="nm">${e(x.person || x.name)}</div>${x.person && x.person !== x.name ? `<div class="tb">${e(x.name)}</div>` : ""}${rows}</div>`;
  }).join("\n");
  return page(`${title}: host badges`, `<p class="meta">Cut along the borders and slip each card behind the alum's name badge.</p><div class="badges">${badges}</div>`, `
.badges { display: grid; grid-template-columns: repeat(2, 3.375in); gap: 0.15in; }
.badge { width: 3.375in; height: 2.125in; border: 1px dashed #8a8780; border-radius: 6px; padding: 8px 10px; overflow: hidden; break-inside: avoid; }
.ev { font-size: 9px; color: #5c5c63; text-transform: uppercase; letter-spacing: .05em; } .nm { font-size: 15px; font-weight: 800; } .tb { font-size: 11px; color: #3a3a3f; margin-bottom: 4px; }
.r { font-size: 11px; line-height: 1.35; } .r span { display: inline-block; width: 52px; color: #5c5c63; } .r i { color: #5c5c63; }
`);
}

/**
 * Several printouts as one document, so a coordinator prints once. Each part
 * keeps its own styles inside a shadow root, so the seating chart's styles
 * never reach the host cards; every part starts on a new page.
 */
export function printEverythingHtml(title: string, parts: [string, string][]): string {
  const tpl = parts.map(([label, html], i) => {
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
      .replace(/@page\s*\{[^}]*\}/g, "").replace(/\bhtml,\s*body\b/g, ":host").replace(/\bbody\b/g, ":host");
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html;
    return `<div class="part" data-label="${e(label)}"></div><template><style>:host { display: block; } ${styles}</style>${body}</template>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}: everything to print</title>
<style>
@page { size: letter; margin: 0.4in; }
body { margin: 0; font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; }
.part { break-before: page; } .part:first-of-type { break-before: auto; }
.bar { position: sticky; top: 0; background: #0f6b5f; color: #fff; padding: 12px 24px; display: flex; gap: 16px; align-items: center; justify-content: space-between; z-index: 2; }
.bar button { font: inherit; font-weight: 700; padding: 8px 18px; border-radius: 8px; border: none; background: #fff; color: #0f6b5f; cursor: pointer; }
@media screen { .part { margin: 24px; } }
@media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><span>${e(title)}: ${parts.map(([l]) => e(l)).join(", ")}. Print on US Letter.</span><button onclick="print()">Print</button></div>
${tpl}
<script>
document.querySelectorAll(".part").forEach(function (host) {
  var t = host.nextElementSibling;
  host.attachShadow({ mode: "open" }).appendChild(t.content.cloneNode(true));
});
</script>
</body></html>
`;
}
