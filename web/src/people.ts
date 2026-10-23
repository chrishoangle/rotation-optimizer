// What a coordinator says about one alum ("arrives for round 2", "can't use
// stairs", "must meet Fam Red") instead of writing pairing rules. The
// settings are stored as ordinary rules, so the planner, the event file,
// and the full planner all keep working; this module only translates.

import type { CleanRow } from "./sheets";
import type { EventState } from "./event";

export interface HostSettings {
  from: number; // first round they host, 1 for all night
  until: number; // last round they host, the number of rounds for all night
  stays: boolean; // stays at one table all night
  stepFree: boolean; // can only reach step-free tables
  must: string[]; // fam names they must meet
  never: string[]; // fam names they must never meet
}

const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const rounds = (s: EventState) => s.plan?.rounds ?? s.rounds;

/** Rules this alum's settings own. Changes made by moving people in the schedule grid are kept apart. */
function owned(r: CleanRow, label: string): boolean {
  return same(r.host_table, label) && r.by !== "grid" && ["only in rounds", "stays with", "needs step-free", "must meet", "never meet"].includes(r.rule)
    && !(r.rule === "must meet" && r.rounds?.trim()) && !(r.rule === "never meet" && r.rounds?.trim());
}

export function hostSettings(s: EventState, hostId: string): HostSettings {
  const row = s.hosts.find((r) => r.host_id === hostId);
  const n = rounds(s);
  const out: HostSettings = { from: 1, until: n, stays: false, stepFree: false, must: [], never: [] };
  if (!row) return out;
  for (const r of s.rules.filter((x) => owned(x, row.table_label))) {
    if (r.rule === "only in rounds") {
      const list = (r.rounds ?? "").split(/[^0-9]+/).map(Number).filter((x) => x >= 1 && x <= n);
      if (list.length) { out.from = Math.min(...list); out.until = Math.max(...list); }
    } else if (r.rule === "stays with") out.stays = true;
    else if (r.rule === "needs step-free") out.stepFree = true;
    else if (r.rule === "must meet" && r.fam) out.must.push(r.fam);
    else if (r.rule === "never meet" && r.fam) out.never.push(r.fam);
  }
  return out;
}

export function setHostSettings(s: EventState, hostId: string, x: HostSettings): void {
  const row = s.hosts.find((r) => r.host_id === hostId);
  if (!row || !row.table_label.trim()) return;
  const label = row.table_label;
  const n = rounds(s);
  const keep = s.rules.filter((r) => !owned(r, label));
  const add: CleanRow[] = [];
  const from = Math.max(1, Math.min(x.from, n)), until = Math.max(from, Math.min(x.until, n));
  if (from > 1 || until < n) add.push({ rule: "only in rounds", host_table: label, fam: "", rounds: Array.from({ length: until - from + 1 }, (_, k) => from + k).join(", ") });
  if (x.stays) add.push({ rule: "stays with", host_table: label, fam: "", rounds: "" });
  if (x.stepFree) add.push({ rule: "needs step-free", host_table: label, fam: "", rounds: "" });
  for (const f of x.must) add.push({ rule: "must meet", host_table: label, fam: f, rounds: "" });
  for (const f of x.never) add.push({ rule: "never meet", host_table: label, fam: f, rounds: "" });
  s.rules = [...keep, ...add];
}

/** Short words for the alum's row: "from round 2", "can't use stairs". */
export function settingsWords(s: EventState, hostId: string): string[] {
  const x = hostSettings(s, hostId);
  const n = rounds(s);
  const out: string[] = [];
  if (x.from > 1 && x.until < n) out.push(`rounds ${x.from} to ${x.until} only`);
  else if (x.from > 1) out.push(`arrives for round ${x.from}`);
  else if (x.until < n) out.push(`leaves after round ${x.until}`);
  if (x.stays) out.push("stays at one table");
  if (x.stepFree) out.push("step-free tables only");
  for (const f of x.must) out.push(`must meet ${f}`);
  for (const f of x.never) out.push(`never meets ${f}`);
  return out;
}

/** A host or fam was renamed: keep every rule pointing at it. */
export function renameInRules(s: EventState, kind: "host" | "fam", before: string, after: string): void {
  if (!before.trim() || same(before, after)) return;
  for (const r of s.rules) {
    if (kind === "host" && same(r.host_table, before)) r.host_table = after;
    if (kind === "fam" && same(r.fam, before)) r.fam = after;
  }
}

/** Changes made by moving alumni in the schedule grid, newest last. */
export function gridChanges(s: EventState): CleanRow[] {
  return s.rules.filter((r) => r.by === "grid");
}

/**
 * Put an alum at a fam's table in one round, as the coordinator dragged it.
 * Earlier grid changes for that alum or that table in the same round are
 * replaced. Returns the rules added, so they can be undone.
 */
export function placeInGrid(s: EventState, hostLabel: string, famLabel: string, round: number): void {
  s.rules = s.rules.filter((r) => !(r.by === "grid" && r.rounds === String(round) && (same(r.host_table, hostLabel) || same(r.fam, famLabel))));
  s.rules.push({ rule: "must meet", host_table: hostLabel, fam: famLabel, rounds: String(round), by: "grid" });
}

export function clearGrid(s: EventState): void {
  s.rules = s.rules.filter((r) => r.by !== "grid");
}
