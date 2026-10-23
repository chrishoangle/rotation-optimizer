// What a coordinator does on the night, as plain functions on the event, so
// the night screen stays thin and the rules here can be tested: who is
// where, a late alum, a no-show, and the log of each change.

import { EventState, normalizeState } from "./event";
import { tableNumbers } from "./export";
import { EventPlan } from "./planning";

/** The round happening now, or about to start: the first one not finished. */
export const currentRound = (s: EventState) => Math.min(s.finished + 1, s.plan?.rounds ?? s.rounds);

export function logChange(s: EventState, at: string, text: string): void {
  s.nightLog.push({ at, text });
}

const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();

export interface Found { kind: "host" | "fam" | "student"; title: string; lines: string[] }

/**
 * Search alumni, host tables, fams, and students by any part of a name, and
 * say where each one is from `round` to the end of the night.
 */
export function whereIs(p: EventPlan, query: string, round: number): Found[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const tables = tableNumbers(p);
  const fam = (id: string) => p.fams.find((f) => f.groupId === id)!;
  const out: Found[] = [];
  for (const h of p.hosts) {
    if (!norm(h.name).includes(q) && !norm(h.person).includes(q)) continue;
    const lines: string[] = [];
    for (let r = round; r <= p.rounds; r++) {
      const a = p.assignments.find((x) => x.round === r && x.hostId === h.hostId);
      if (a) lines.push(`Round ${r}: Table ${tables[a.groupId]} (${fam(a.groupId).name})`);
      else if ((p.hostAway[h.hostId] ?? []).includes(r)) lines.push(`Round ${r}: cancelled`);
      else if ((p.hostLimits[h.hostId] ?? []).includes(r)) lines.push(`Round ${r}: not hosting`);
      else lines.push(`Round ${r}: no table this round`);
    }
    out.push({ kind: "host", title: h.person ? `${h.person} (${h.name})` : h.name, lines });
  }
  for (const f of p.fams) {
    const students = f.members.filter((m) => norm(m).includes(q));
    if (!norm(f.name).includes(q) && !students.length) continue;
    if (students.length && !norm(f.name).includes(q)) {
      for (const m of students) out.push({ kind: "student", title: m, lines: [`Table ${tables[f.groupId]} (${f.name}) all night`] });
      continue;
    }
    const lines: string[] = [`Seated at Table ${tables[f.groupId]}`];
    for (let r = round; r <= p.rounds; r++) {
      const a = p.assignments.find((x) => x.round === r && x.groupId === f.groupId);
      const h = a ? p.hosts.find((x) => x.hostId === a.hostId)! : null;
      lines.push(`Round ${r}: ` + (h ? (h.person ? `${h.person} (${h.name})` : h.name) : (p.famAway[f.groupId] ?? []).includes(r) ? "cancelled" : "no host"));
    }
    out.push({ kind: "fam", title: f.name, lines });
  }
  return out.slice(0, 12);
}

export interface LateHost { table: string; person: string; tags: string; from: number }

/**
 * Add an alum who turned up or was confirmed late. They host from round
 * `from` to the end, through an "only in rounds" rule, so finished rounds
 * and the printed schedule stay as they are. Returns a problem in plain
 * words, or "" when the alum was added. Re-plan afterwards.
 */
export function addLateHost(s: EventState, late: LateHost, at: string): string {
  const name = late.table.trim();
  if (!name) return "Give the host table a name, for example the alum's field.";
  if (s.hosts.some((r) => (r.table_label ?? "").trim().toLowerCase() === name.toLowerCase())) {
    return `There is already a host table named ${name}. Use a different name, for example ${name} 2.`;
  }
  const rounds = s.plan?.rounds ?? s.rounds;
  if (late.from < s.finished + 1 || late.from > rounds) return `Choose a round from ${s.finished + 1} to ${rounds}.`;
  s.hosts.push({ table_label: name, host_name: late.person.trim(), tags: late.tags.trim() });
  normalizeState(s);
  if (late.from > 1) {
    const list = Array.from({ length: rounds - late.from + 1 }, (_, k) => late.from + k);
    s.rules.push({ rule: "only in rounds", host_table: name, fam: "", rounds: list.join(", ") });
  }
  const id = s.hosts[s.hosts.length - 1].host_id;
  if (!s.arrived.includes(id)) s.arrived.push(id);
  logChange(s, at, `Added ${late.person.trim() ? `${late.person.trim()} (${name})` : name} as a host from round ${late.from}.`);
  return "";
}

/** A host who did not come, or has to leave: cancelled from `from` on. */
export function cancelHost(s: EventState, hostId: string, from: number, at: string, noShow = false): void {
  s.cancelHosts[hostId] = from;
  s.arrived = s.arrived.filter((x) => x !== hostId);
  const row = s.hosts.find((r) => r.host_id === hostId);
  const who = row ? (row.host_name ? `${row.host_name} (${row.table_label})` : row.table_label) : hostId;
  logChange(s, at, noShow ? `${who} did not show up, cancelled from round ${from}.` : `${who} cancelled from round ${from}.`);
}

export function cancelFam(s: EventState, famId: string, from: number, at: string): void {
  s.cancelFams[famId] = from;
  const row = s.fams.find((r) => r.fam_id === famId);
  logChange(s, at, `${row?.fam_label ?? famId} cancelled from round ${from}.`);
}

export function finishRound(s: EventState, at: string): void {
  const rounds = s.plan?.rounds ?? s.rounds;
  if (s.finished >= rounds - 1) return;
  s.finished += 1;
  logChange(s, at, `Round ${s.finished} finished.`);
}

/** Hosts who are expected tonight and not yet checked in. */
export function notArrived(s: EventState): { id: string; label: string }[] {
  return s.hosts
    .filter((r) => r.host_id && r.table_label && !(r.host_id in s.cancelHosts) && !s.arrived.includes(r.host_id))
    .map((r) => ({ id: r.host_id, label: r.host_name ? `${r.host_name} (${r.table_label})` : r.table_label }));
}

// ----------------------------------------------------------------------
// The room.
// ----------------------------------------------------------------------

/** Table numbers as the plan has them, or as the rows say when there is no plan. */
export function currentTables(s: EventState): Record<string, number> {
  if (s.plan) return tableNumbers(s.plan);
  const out: Record<string, number> = {};
  s.fams.forEach((r, i) => { if (r.fam_id) out[r.fam_id] = Number(r.table_number) || i + 1; });
  return out;
}

export function toggleSetup(s: EventState, famId: string): void {
  const done = new Set(s.night.setup ?? []);
  if (done.has(famId)) done.delete(famId); else done.add(famId);
  s.night = { ...s.night, setup: s.fams.map((r) => r.fam_id).filter((id) => done.has(id)) };
}

/** Tables not yet checked during setup, as "Table 3 (Fam Red)". */
export function setupMissing(s: EventState): string[] {
  const done = new Set(s.night.setup ?? []);
  const tables = roomTables(s);
  return s.fams.filter((r) => r.fam_id && r.fam_label && !done.has(r.fam_id)).map((r) => `Table ${tables[r.fam_id]} (${r.fam_label})`);
}

/**
 * The fam is sitting at a different table than planned, the original
 * failure: tents swapped, or students seated before the tents went out.
 * Rather than move the students, change the number. When another fam has
 * that number, the two swap. Re-plan afterwards: the printed pairings stay,
 * and the alumni who have to walk somewhere else are listed.
 */
export function moveFamTable(s: EventState, famId: string, table: number, at: string): string {
  if (!Number.isInteger(table) || table < 1) return "Type the number on the table where the fam is sitting, for example 7.";
  const tables = currentTables(s);
  const row = s.fams.find((r) => r.fam_id === famId);
  if (!row) return "That fam is not in the event.";
  const old = tables[famId];
  if (old === table) return `${row.fam_label} is already at Table ${table}.`;
  for (const r of s.fams) if (r.fam_id && !String(r.table_number ?? "").trim()) r.table_number = String(tables[r.fam_id]);
  const other = s.fams.find((r) => r.fam_id !== famId && Number(r.table_number) === table);
  row.table_number = String(table);
  if (other) other.table_number = String(old);
  s.night = { ...s.night, setup: (s.night.setup ?? []).filter((id) => id !== famId && id !== other?.fam_id) };
  logChange(s, at, `${row.fam_label} is at Table ${table}, not ${old}` + (other ? `; ${other.fam_label} moves to Table ${old}.` : "."));
  return "";
}

/**
 * An alum who is in the event but arrived after it started: they host from
 * round `from` on. Undoes a "didn't show" cancellation and limits them with
 * an "only in rounds" rule, keeping any limit they already had.
 */
export function joinLate(s: EventState, hostId: string, from: number, at: string): string {
  const row = s.hosts.find((r) => r.host_id === hostId);
  const rounds = s.plan?.rounds ?? s.rounds;
  if (!row) return "That alum is not in the event.";
  if (from < s.finished + 1 || from > rounds) return `Choose a round from ${s.finished + 1} to ${rounds}.`;
  delete s.cancelHosts[hostId];
  if (from > 1) {
    const label = (row.table_label ?? "").trim().toLowerCase();
    const rule = s.rules.find((r) => r.rule === "only in rounds" && (r.host_table ?? "").trim().toLowerCase() === label);
    const before = rule ? (rule.rounds ?? "").split(/[^0-9]+/).map(Number).filter((n) => n >= 1 && n <= rounds) : Array.from({ length: rounds }, (_, k) => k + 1);
    const keep = before.filter((r) => r >= from);
    if (!keep.length) return `${row.table_label} only comes for rounds before ${from}. Change their rule under Pairing rules instead.`;
    if (rule) rule.rounds = keep.join(", ");
    else s.rules.push({ rule: "only in rounds", host_table: row.table_label, fam: "", rounds: keep.join(", ") });
  }
  if (!s.arrived.includes(hostId)) s.arrived.push(hostId);
  const who = row.host_name ? `${row.host_name} (${row.table_label})` : row.table_label;
  logChange(s, at, `${who} arrived late and hosts from round ${from}.`);
  return "";
}

/** Table numbers as the rows say now, even before a re-plan picks up a change. */
export function roomTables(s: EventState): Record<string, number> {
  const planned = currentTables(s);
  const out: Record<string, number> = {};
  s.fams.forEach((r, i) => { if (r.fam_id) out[r.fam_id] = Number(r.table_number) || planned[r.fam_id] || i + 1; });
  return out;
}
