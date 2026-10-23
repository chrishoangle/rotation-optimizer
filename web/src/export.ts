// The printouts and the schedule spreadsheet. A port of
// src/rotation_optimizer/export.py; for the same plan, every page is the
// same HTML byte for byte (checked by test/parity.test.ts).

import { EventPlan, FAM_ABSENT, NO_HOST, hostLabel } from "./planning";
import { csvLine, htmlEscape as e } from "./py";

const BASE_CSS = `
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; margin: 0; }
@media screen { body { margin: 24px; } }
`;

const STAMP_CSS = ".stamp { display: inline-block; font-size: 12px; font-weight: 700; color: #8a1c1c; border: 1.5px solid #8a1c1c; border-radius: 4px; padding: 1px 6px; margin: 0 0 6px; }";

const range = (n: number) => Array.from({ length: n }, (_, k) => k + 1);
const has = (m: Record<string, number[]>, id: string, r: number) => (m[id] ?? []).includes(r);

export function tagWords(tag: string): string {
  return tag.replace(/(?<=[a-z]{4})-(?=[a-z]{4})/g, " ");
}

function stamp(updated: string): string {
  return updated ? `<div class="stamp">Updated ${e(updated)}. Replaces the earlier copy.</div>` : "";
}

function counts(p: EventPlan): string {
  const part = (n: number, noun: string, gone: Record<string, number[]>, plural = "") => {
    let text = `${n} ${n === 1 ? noun : plural || noun + "s"}`;
    const lists = Object.values(gone);
    if (lists.length) text += ` (${lists.length} cancelled from round ${Math.min(...lists.map((rs) => Math.min(...rs)))})`;
    return text;
  };
  return part(p.fams.length, "fam", p.famAway) + ", " + part(p.hosts.length, "alum", p.hostAway, "alumni") + `, ${p.rounds} round${p.rounds !== 1 ? "s" : ""}.`;
}

export function tableNumbers(p: EventPlan): Record<string, number> {
  return Object.fromEntries(p.fams.map((f, i) => [f.groupId, f.tableNumber || i + 1]));
}

export interface ScheduleRow { round: number; table: number; fam: string; host_table: string; score: number }

export function scheduleRows(p: EventPlan): ScheduleRow[] {
  const hosts = Object.fromEntries(p.hosts.map((h) => [h.hostId, h.name]));
  const tables = tableNumbers(p);
  const bySlot = new Map(p.assignments.map((a) => [`${a.round}\u0000${a.groupId}`, a]));
  const ordered = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const rows: ScheduleRow[] = [];
  for (const r of range(p.rounds)) for (const f of ordered) {
    const a = bySlot.get(`${r}\u0000${f.groupId}`);
    const host = a ? hosts[a.hostId] : has(p.famAway, f.groupId, r) ? FAM_ABSENT : NO_HOST;
    rows.push({ round: r, table: tables[f.groupId], fam: f.name, host_table: host, score: a ? a.score : 0 });
  }
  return rows;
}

export function scheduleCsv(p: EventPlan): string {
  return ["round,table,fam,host_table,score", ...scheduleRows(p).map((r) => csvLine([r.round, r.table, r.fam, r.host_table, r.score]))].join("\n") + "\n";
}

export function availabilityText(p: EventPlan, hostId: string): string {
  const present = range(p.rounds).filter((r) => !has(p.hostLimits, hostId, r));
  if (!present.length) return "not hosting";
  if (present.length === 1) return `round ${present[0]} only`;
  return "rounds " + present.slice(0, -1).join(", ") + ` and ${present[present.length - 1]} only`;
}

export function findYourTableRows(p: EventPlan): [string, number, string][] {
  const tables = tableNumbers(p);
  const rows: [string, number, string][] = p.fams.flatMap((f) => f.members.map((m): [string, number, string] => [m, tables[f.groupId], f.name]));
  return rows.sort((a, b) => {
    const x = a[0].toLowerCase(), y = b[0].toLowerCase();
    return x < y ? -1 : x > y ? 1 : a[1] - b[1];
  });
}

export function seatingChartHtml(
  p: EventPlan, title = "Rotation schedule", rounds: number[] | null = null, finder = true, updated = "",
  locations: Record<string, string> = {},
): string {
  const rows = scheduleRows(p);
  const where = Object.fromEntries(p.fams.map((f) => [f.name, locations[f.groupId] ?? ""]));
  const person: Record<string, string> = Object.fromEntries(p.hosts.filter((h) => h.person && h.person !== h.name).map((h) => [h.name, h.person]));
  const hosts = Object.fromEntries(p.hosts.map((h) => [h.hostId, hostLabel(h)]));
  const sections: string[] = [];
  const st = stamp(updated);
  for (const r of rounds && rounds.length ? rounds : range(p.rounds)) {
    const cards = rows.filter((row) => row.round === r).map((row) =>
      `<div class="card"><div class="num">Table ${row.table}</div><div class="fam">${e(row.fam)}</div>` +
      (where[row.fam] ? `<div class="loc">${e(where[row.fam])}</div>` : "") +
      `<div class="host${row.score || ![NO_HOST, FAM_ABSENT].includes(row.host_table) ? "" : " open"}">` +
      // People first: the alum's name is the headline, their topic the small line.
      `${e(person[String(row.host_table)] ?? String(row.host_table))}</div>` +
      (person[String(row.host_table)] ? `<div class="who">${e(String(row.host_table))}</div>` : "") + "</div>").join("");
    const breaks = Object.entries(p.hostBreaks).filter(([h, rs]) => rs.includes(r) && !has(p.hostAway, h, r) && !has(p.hostLimits, h, r)).map(([h]) => hosts[h]);
    const away = Object.entries(p.hostAway).filter(([, rs]) => rs.includes(r)).map(([h]) => hosts[h]);
    const limited = Object.entries(p.hostLimits).filter(([h, rs]) => rs.includes(r) && !has(p.hostAway, h, r)).map(([h]) => `${hosts[h]}: ${availabilityText(p, h)}`);
    let notes = "";
    if (breaks.length) notes += `<p class="note">No table this round: ${e(breaks.join(", "))}</p>`;
    if (limited.length) notes += `<p class="note">Not hosting this round: ${e(limited.join("; "))}</p>`;
    if (away.length) notes += `<p class="note">Cancelled: ${e(away.join(", "))}</p>`;
    sections.push(`<section><h2>Round ${r}</h2>${st}<div class="grid">${cards}</div>${notes}</section>`);
  }
  const names = finder ? findYourTableRows(p) : [];
  if (names.length) {
    const items = names.map(([name, num, fam]) => `<tr><td>${e(name)}</td><td class="tn">Table ${num}</td><td>${e(fam)}</td></tr>`).join("");
    sections.push(`<section><h2>Find your table</h2>${st}<table class="finder">${items}</table></section>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${BASE_CSS}
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 20px; margin: 18px 0 10px; }
.meta { color: #5c5c63; margin: 0 0 8px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.card { border: 1px solid #c9c6bf; border-radius: 8px; padding: 8px 10px; break-inside: avoid; }
.num { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #5c5c63; }
.fam { font-size: 13px; color: #3a3a3f; } .host { font-weight: 700; font-size: 15px; }
.host.open { color: #b4530a; } .note { color: #5c5c63; font-size: 13px; } .loc { font-size: 12px; color: #5c5c63; } .who { font-size: 13px; }
section { break-before: page; } section:first-of-type { break-before: auto; }
.finder { border-collapse: collapse; width: 100%; columns: 2; } .finder td { border-bottom: 1px solid #e3e0d9; padding: 4px 6px; font-size: 13px; }
.finder td.tn { font-weight: 700; white-space: nowrap; }
${STAMP_CSS}
</style></head><body>
<h1>${e(title)}</h1>
<p class="meta">${counts(p)}</p>
${sections.join("")}
</body></html>
`;
}

function cardInches(person: string, rows: string[]): number {
  let textLines = 0;
  for (const row of rows) {
    const parts = row.replace(/<[^>]+>/g, "\n").split("\n").filter((x) => x.trim());
    textLines += parts.length > 2 ? parts.slice(2).reduce((s, x) => s + Math.max(1, Math.ceil([...x].length / 70)), 0) : 1;
  }
  const rowsHeight = 0.33 * rows.length + 0.19 * Math.max(0, textLines - rows.length);
  return 0.6 + 0.75 + (person ? 0.25 : 0) + rowsHeight + 0.3;
}

export function hostCardsHtml(
  p: EventPlan, hostIds: string[] | null = null, title = "Host cards", updated = "", locations: Record<string, string> = {},
): string {
  const tables = tableNumbers(p);
  const fams = Object.fromEntries(p.fams.map((f) => [f.groupId, f]));
  const byHost = new Map(p.assignments.map((a) => [`${a.hostId}\u0000${a.round}`, a.groupId]));
  const cards: string[] = [];
  for (const h of p.hosts.filter((x) => hostIds === null || hostIds.includes(x.hostId))) {
    const lines: string[] = [];
    const tags = new Set(h.tags);
    for (const r of range(p.rounds)) {
      const fId = byHost.get(`${h.hostId}\u0000${r}`);
      if (fId) {
        const f = fams[fId];
        const shared = f.interests.filter((t) => tags.has(t));
        const other = f.interests.filter((t) => !tags.has(t));
        let pts = "";
        if (shared.length) pts += `<div class="pts"><b>You share:</b> ${e(shared.map(tagWords).join(", "))}</div>`;
        if (other.length) pts += `<div class="pts">${shared.length ? "Also interested in" : "Interested in"}: ${e(other.map(tagWords).join(", "))}</div>`;
        lines.push(`<tr><td class="r">Round ${r}</td><td class="t">Table ${tables[fId]}</td><td><div class="fam">${e(f.name)}</div>` +
          (locations[fId] ? `<div class="loc">${e(locations[fId])}</div>` : "") + `${pts}</td></tr>`);
      } else if (has(p.hostAway, h.hostId, r)) {
        lines.push(`<tr><td class="r">Round ${r}</td><td class="t"></td><td><div class="fam">Cancelled for this round</div></td></tr>`);
      } else if (has(p.hostLimits, h.hostId, r)) {
        lines.push(`<tr><td class="r">Round ${r}</td><td class="t"></td><td><div class="fam">Not hosting this round</div></td></tr>`);
      } else {
        lines.push(`<tr><td class="r">Round ${r}</td><td class="t"></td><td><div class="fam">No table this round</div>` +
          '<div class="pts">More hosts than fams this round. Please wait near the front for the next round.</div></td></tr>');
      }
    }
    cards.push(
      `<article class="hc${cardInches(h.person, lines) > 4.9 ? " full" : ""}"><div class="head">${stamp(updated)}<span class="lbl">Your tables tonight</span><h2>${e(h.person || h.name)}</h2>` +
      (h.person && h.person !== h.name ? `<div class="person">${e(h.name)}</div>` : "") + "</div>" +
      `<table>${lines.join("")}</table><p class="foot">${e(title)}. Move when the MC calls the round.</p></article>`,
    );
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${BASE_CSS}
.hc { min-height: 4.9in; border: 1px dashed #9a978f; padding: 0.3in 0.35in; display: flex; flex-direction: column; break-inside: avoid; }
.hc + .hc { margin-top: 0.1in; }
.hc.full { min-height: 0; } .hc.full + .hc { break-before: page; }
.lbl { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #5c5c63; }
h2 { font-size: 26px; margin: 2px 0 2px; }
.person { font-size: 15px; color: #3a3a3f; margin-bottom: 6px; } .head { margin-bottom: 8px; }
table { border-collapse: collapse; width: 100%; }
td { border-top: 1px solid #d6d3cc; padding: 9px 6px; vertical-align: top; }
td.r { width: 1.0in; font-weight: 600; } td.t { width: 1.1in; font-size: 22px; font-weight: 800; }
.fam { font-weight: 700; font-size: 16px; } .pts { font-size: 12.5px; color: #3a3a3f; margin-top: 2px; } .loc { font-size: 12.5px; color: #5c5c63; }
.foot { margin-top: auto; font-size: 11px; color: #5c5c63; }
${STAMP_CSS}
</style></head><body>
${cards.join("") || "<p>No host cards to print.</p>"}
</body></html>
`;
}

export function tableTentsHtml(p: EventPlan, famIds: string[] | null = null, updated = ""): string {
  const tables = tableNumbers(p);
  const wanted = p.fams.filter((f) => famIds === null || famIds.includes(f.groupId)).sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const tents = wanted.map((f) => {
    const face = `<div class="face"><div class="n">${tables[f.groupId]}</div><div class="nm">${e(f.name)}</div></div>`;
    return `<article class="tent">${stamp(updated)}<div class="flip">${face}</div><div class="fold"></div>${face}</article>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Table tents</title>
<style>${BASE_CSS}
@page { size: letter; margin: 0.4in; }
.tent { height: 10.1in; display: flex; flex-direction: column; break-after: page; }
.tent:last-of-type { break-after: auto; }
.face { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.flip { flex: 1; display: flex; transform: rotate(180deg); }
.fold { border-top: 1px dashed #9a978f; }
.n { font-size: 220px; font-weight: 800; line-height: 1; }
.nm { font-size: 30px; font-weight: 600; margin-top: 8px; padding: 0 0.3in; }
${STAMP_CSS}
</style></head><body>
${tents.join("") || "<p>No table tents to print.</p>"}
</body></html>
`;
}

export function hostViewRows(p: EventPlan): Record<string, string>[] {
  const tables = tableNumbers(p);
  const fams = Object.fromEntries(p.fams.map((f) => [f.groupId, f]));
  const byHost = new Map(p.assignments.map((a) => [`${a.hostId}\u0000${a.round}`, a.groupId]));
  const named = p.hosts.some((h) => h.person);
  return p.hosts.map((h) => {
    const row: Record<string, string> = { host_table: h.name };
    if (named) row.host_name = h.person;
    for (const r of range(p.rounds)) {
      const fId = byHost.get(`${h.hostId}\u0000${r}`);
      if (fId) row[`round ${r}`] = `Table ${tables[fId]} (${fams[fId].name})`;
      else if (has(p.hostAway, h.hostId, r)) row[`round ${r}`] = "Cancelled";
      else if (has(p.hostLimits, h.hostId, r)) row[`round ${r}`] = `Not hosting (${availabilityText(p, h.hostId)})`;
      else row[`round ${r}`] = "No table this round";
    }
    return row;
  });
}

/** start such as "18:30" or "6:30 PM", plus minutes, as "7:05 PM". Blank when start is blank or unreadable. */
export function clock(start: string, minutes: number): string {
  const text = (start || "").trim().toUpperCase().replace(/\./g, "");
  let h: number, m: number;
  let match = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) {
    h = +match[1]; m = +match[2];
    if (h > 23 || m > 59) return "";
  } else if ((match = text.match(/^(\d{1,2})(?::(\d{1,2}))? ?(AM|PM)$/))) {
    h = +match[1]; m = match[2] ? +match[2] : 0;
    if (h < 1 || h > 12 || m > 59) return "";
    h = (h % 12) + (match[3] === "PM" ? 12 : 0);
  } else return "";
  const total = (h * 60 + m + minutes) % (24 * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

function firstTable(p: EventPlan, hostId: string, tables: Record<string, number>, byHost: Map<string, string>): string {
  for (const r of range(p.rounds)) {
    const fId = byHost.get(`${hostId}\u0000${r}`);
    if (fId) return `Table ${tables[fId]}` + (r === 1 ? "" : ` (from round ${r})`);
  }
  return "No table";
}

export function runSheetHtml(p: EventPlan, title = "Run sheet", startTime = "", roundMinutes = 20, welcomeMinutes = 10, switchMinutes = 5): string {
  const tables = tableNumbers(p);
  const byHost = new Map(p.assignments.map((a) => [`${a.hostId}\u0000${a.round}`, a.groupId]));
  const ordered = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const steps: [number, string, string][] = [
    [0, "Doors open", "Hosts and fams check in on the lists below. Fams sit at their table number."],
    [welcomeMinutes, "Welcome", "Welcome everyone. Fams stay seated all night; hosts move between tables each round."],
  ];
  let t = welcomeMinutes + switchMinutes;
  for (const r of range(p.rounds)) {
    const notes: string[] = [];
    const idle = p.hosts.filter((h) => !byHost.has(`${h.hostId}\u0000${r}`));
    const out = idle.filter((h) => has(p.hostAway, h.hostId, r)).map(hostLabel);
    const limited = idle.filter((h) => has(p.hostLimits, h.hostId, r) && !has(p.hostAway, h.hostId, r)).map(hostLabel);
    const breaks = idle.filter((h) => !has(p.hostAway, h.hostId, r) && !has(p.hostLimits, h.hostId, r)).map(hostLabel);
    const open = ordered.filter((f) => !p.assignments.some((a) => a.round === r && a.groupId === f.groupId) && !has(p.famAway, f.groupId, r)).map((f) => String(tables[f.groupId]));
    if (open.length) notes.push(`No host at table ${open.join(", ")} this round.`);
    if (breaks.length) notes.push(`No table this round: ${breaks.join(", ")}.`);
    if (limited.length) notes.push(`Not hosting this round: ${limited.join(", ")}.`);
    if (out.length) notes.push(`Cancelled: ${out.join(", ")}.`);
    const say = r === 1 ? `Round ${r} starts. Hosts, go to the table on your host card for round ${r}.`
      : `Thank your table. Hosts, move to the table on your host card for round ${r}.`;
    steps.push([t, `Round ${r}`, [say, ...notes].join(" ")]);
    t += roundMinutes + (r < p.rounds ? switchMinutes : 0);
  }
  steps.push([t, "Closing", "Thank the hosts and the fams. Collect table tents and host cards."]);
  const when = (m: number) => { const c = clock(startTime, m); return c ? e(c) : '<span class="blank"></span>'; };
  const timeline = steps.map(([m, what, say]) => `<tr><td class="time">${when(m)}</td><td class="what">${e(what)}</td><td>${e(say)}</td></tr>`).join("");
  // A topic column only when some alum has a topic that is not just their name.
  const named = p.hosts.some((h) => h.person && h.person !== h.name);
  const hostRows = p.hosts.map((h) => `<tr><td class="box"></td>` + (named ? `<td>${e(h.person || h.name)}</td><td>${h.person && h.person !== h.name ? e(h.name) : ""}</td>` : `<td>${e(h.person || h.name)}</td>`) +
    `<td>${firstTable(p, h.hostId, tables, byHost)}</td></tr>`).join("");
  const famRows = ordered.map((f) => `<tr><td class="box"></td><td>Table ${tables[f.groupId]}</td><td>${e(f.name)}</td><td>${f.size || f.members.length || ""}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}: run sheet</title>
<style>${BASE_CSS}
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 18px 0 8px; }
.meta { color: #5c5c63; margin: 0 0 8px; }
table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid #e3e0d9; padding: 6px; vertical-align: top; text-align: left; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5c5c63; }
.time { width: 1.1in; font-weight: 700; white-space: nowrap; } .what { width: 1.3in; font-weight: 700; }
.blank { display: inline-block; width: 0.8in; border-bottom: 1px solid #1c1c1e; }
.box { width: 0.35in; } .box::before { content: ""; display: inline-block; width: 14px; height: 14px; border: 1.5px solid #1c1c1e; }
section { break-before: page; } section:first-of-type { break-before: auto; }
.help { font-size: 13px; color: #3a3a3f; }
</style></head><body>
<section>
<h1>${e(title)}: run sheet</h1>
<p class="meta">${p.rounds} rounds, ${p.hosts.length} alumni, ${p.fams.length} fams.</p>
<h2>MC timeline</h2>
<table>${timeline}</table>
<h2>If someone cancels during the night</h2>
<p class="help">In the app, open Run, tap Someone changed?, and say what happened.
Tell the people it lists, and hand out change slips if you print them. Rounds already finished never change.</p>
</section>
<section>
<h2>Check-in: alumni</h2>
<table><tr><th></th>${named ? "<th>Alum</th><th>Topic</th>" : "<th>Alum</th>"}<th>Round 1</th></tr>${hostRows}</table>
<h2>Check-in: fams</h2>
<table><tr><th></th><th>Table</th><th>Fam</th><th>Students</th></tr>${famRows}</table>
</section>
</body></html>
`;
}
