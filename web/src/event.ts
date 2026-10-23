// One event as a coordinator works on it, and its event file. A port of
// src/rotation_optimizer/event.py. Event files are interchangeable with the
// Python app: same format, same fields, same fingerprint.

import { Assignment, makeGroup, makeHost } from "./models";
import { EventPlan, InfeasibleProblemError, planEvent, provenOptimal, slots } from "./planning";
import { pyJsonDumps, sha256Hex } from "./py";
import {
  CleanRow, Row, Rule, SheetError, cleanRows, famsFromRows, hostsFromRows, parseRuleRows, splitTags,
} from "./sheets";
import type { HighsLike } from "./solver";
import type { GuestGroup, Host } from "./models";

export const FILE_FORMAT = "rotation-optimizer-event";
export const FILE_VERSION = 1;
export const HOST_COLUMNS = ["host_id", "table_label", "host_name", "tags"];
export const FAM_COLUMNS = ["fam_id", "table_number", "fam_label", "size", "interests", "students", "location", "step_free"];
export const RULE_COLUMNS = ["rule", "host_table", "fam", "rounds"];

export interface EventState {
  title: string;
  rounds: number;
  hosts: CleanRow[];
  fams: CleanRow[];
  rules: CleanRow[];
  finished: number;
  cancelHosts: Record<string, number>; // host id: first round missed
  cancelFams: Record<string, number>;
  plan: EventPlan | null;
  planInputs: string | null;
  printed: EventPlan | null;
  oneWeakRound: boolean;
  planTables: { hosts: CleanRow[]; fams: CleanRow[] } | null;
  startTime: string;
  roundMinutes: number;
  switchMinutes: number; // alumni moving between rounds
  openMinutes: number; // an open floor after the last round, 0 for none
  printedAt: string;
  arrived: string[]; // host ids checked in on the night
  notes: string; // notes for next year's coordinator, kept in the hand-off
  nightLog: { at: string; text: string }[]; // each change on the night
  night: NightState; // what happened in the room; never used for planning
}

/** Kept by night mode and saved in the event file. */
export interface NightState {
  roundTimes?: Record<string, { start?: string; end?: string }>; // "1": {start: "18:31"}; 24-hour clock times
  setup?: string[]; // fam ids whose table was checked during setup
  told?: string[]; // change keys passed on to the alum
  moved?: string[]; // "round|host id" for alumni who reached their table
  famArrived?: Record<string, number>; // students arrived per fam id
  wrapUp?: boolean; // the wrap-up question was answered or dismissed
  startedAt?: Record<string, number>; // "1": when round 1 was started on this device, in ms, for a clock to the second
  date?: string; // the event's date, "2026-11-14", so lateness is only shown on the day
  reviewed?: string; // the schedule the coordinator said looks good, as planSig gives it
  tablesBefore?: Record<string, { table_number: string; location: string; step_free: string }>; // fam rows before a move on the night
}

export function newEvent(p: Partial<EventState> = {}): EventState {
  return {
    title: "Alumni dinner", rounds: 2, hosts: [], fams: [], rules: [], finished: 0, cancelHosts: {}, cancelFams: {},
    plan: null, planInputs: null, printed: null, oneWeakRound: false, planTables: null, startTime: "", roundMinutes: 20,
    switchMinutes: 5, openMinutes: 0, printedAt: "", arrived: [], notes: "", nightLog: [], night: {}, ...p,
  };
}

export interface Inputs {
  hosts: Host[];
  fams: GuestGroup[];
  rules: Rule[];
  onlyInRounds: Record<string, number[]>;
  problems: string[];
  warnings: string[];
}

export function normalizeTable(rows: Iterable<Row>, columns: string[], idColumn: string | null, idPrefix: string): CleanRow[] {
  const clean = cleanRows(rows);
  const used = new Set(idColumn ? clean.map((r) => r[idColumn] ?? "") : []);
  let n = 1;
  return clean.map((row) => {
    const out: CleanRow = {};
    for (const c of columns) out[c] = row[c] ?? "";
    for (const [k, v] of Object.entries(row)) if (!(k in out)) out[k] = v;
    if (idColumn && !out[idColumn]) {
      while (used.has(`${idPrefix}${String(n).padStart(2, "0")}`)) n++;
      out[idColumn] = `${idPrefix}${String(n).padStart(2, "0")}`;
      used.add(out[idColumn]);
    }
    return out;
  });
}

export function normalizeState(s: EventState): void {
  s.hosts = normalizeTable(s.hosts, HOST_COLUMNS, "host_id", "h");
  s.fams = normalizeTable(s.fams, FAM_COLUMNS, "fam_id", "fam_");
  s.rules = normalizeTable(s.rules, RULE_COLUMNS, null, "");
}

export function maxRounds(s: EventState): number {
  return Math.max(s.hosts.length, s.fams.length, 1);
}

export function roundsLimitText(s: EventState): string {
  const top = maxRounds(s);
  const what = s.hosts.length >= s.fams.length ? `host tables (${top})` : `fams (${top})`;
  return `Rounds can't be more than the number of ${what}, or some fam would meet the same host twice.`;
}

export function checkInputs(s: EventState): Inputs {
  const [hosts, hostProblems, hostWarnings] = hostsFromRows(s.hosts);
  const [fams, famProblems, famWarnings] = famsFromRows(s.fams);
  const problems = [...hostProblems, ...famProblems];
  let rules: Rule[] = [];
  let only: Record<string, number[]> = {};
  try {
    [rules, only] = parseRuleRows(s.rules, hosts, fams, s.rounds);
  } catch (err) {
    if (err instanceof SheetError) problems.push(...err.problems);
    else throw err;
  }
  if (s.rounds > maxRounds(s)) problems.push(roundsLimitText(s));
  return { hosts, fams, rules, onlyInRounds: only, problems, warnings: [...hostWarnings, ...famWarnings] };
}

/** A hash of everything a plan depends on, identical to the Python app's, so saved files stay up to date across both. */
/** A fam row without cells planning never reads (see event.py). */
function planningCells(row: CleanRow): CleanRow {
  const { location: _location, ...out } = row;
  if (!out.step_free) delete out.step_free;
  return out;
}

const STEP_FREE_NO = new Set(["", "no", "n", "false", "0", "not step-free"]);

export function stepFreeFams(s: EventState): string[] {
  return cleanRows(s.fams).filter((r) => r.fam_id && !STEP_FREE_NO.has((r.step_free ?? "").trim().toLowerCase())).map((r) => r.fam_id);
}

export function famLocations(s: EventState): Record<string, string> {
  return Object.fromEntries(cleanRows(s.fams).filter((r) => r.fam_id && r.location).map((r) => [r.fam_id, r.location]));
}

export function fingerprint(s: EventState): string {
  const payload: Record<string, unknown> = {
    rounds: s.rounds,
    hosts: cleanRows(s.hosts),
    fams: cleanRows(s.fams).map(planningCells),
    rules: cleanRows(s.rules),
    cancel_hosts: s.cancelHosts,
    cancel_fams: s.cancelFams,
  };
  if (s.oneWeakRound) payload.one_weak_round = true;
  return sha256Hex(pyJsonDumps(payload, true));
}

export const isCurrent = (s: EventState) => s.plan !== null && s.planInputs === fingerprint(s);
export const hasStarted = (s: EventState) => s.finished > 0 || !!(s.plan && s.plan.lockedRounds.length);

/** Plan, or re-plan keeping finished rounds and the printed schedule. Throws SheetError or InfeasibleProblemError. */
export function solveEvent(highs: HighsLike, s: EventState, keepPrinted = true): EventPlan {
  normalizeState(s);
  const inputs = checkInputs(s);
  if (inputs.problems.length) throw new SheetError(inputs.problems);
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => a + k);
  const hostAway = Object.fromEntries(Object.entries(s.cancelHosts).map(([h, first]) => [h, range(first, s.rounds)]));
  const famAway = Object.fromEntries(Object.entries(s.cancelFams).map(([f, first]) => [f, range(first, s.rounds)]));
  let locked: [number, string, string][] = [];
  let keep: [number, string, string][] = [];
  if (s.plan) {
    const done = Math.max(s.finished, ...s.plan.lockedRounds);
    s.finished = done;
    locked = s.plan.assignments.filter((a) => a.round <= done).map((a) => [a.round, a.hostId, a.groupId]);
    if (keepPrinted) {
      const base = s.printed ?? s.plan;
      keep = base.assignments.filter((a) => a.round > done).map((a) => [a.round, a.hostId, a.groupId]);
    }
  }
  const plan = planEvent(highs, inputs.hosts, inputs.fams, s.rounds, {
    rules: inputs.rules, hostAway, famAway, locked, keep, hostLimits: inputs.onlyInRounds,
    weakLimit: s.oneWeakRound ? 1 : null, stepFreeFams: stepFreeFams(s),
  });
  plan.warnings = [...inputs.warnings, ...plan.warnings];
  s.plan = plan;
  s.planInputs = fingerprint(s);
  s.planTables = { hosts: structuredClone(s.hosts), fams: structuredClone(s.fams) };
  return plan;
}

export function restoreRemovedRows(s: EventState): string[] {
  if (!s.plan) return [];
  const restored: string[] = [];
  const snap = s.planTables ?? { hosts: [], fams: [] };
  const merge = (current: CleanRow[], saved: CleanRow[], planIds: string[], idCol: string, rebuild: (id: string) => CleanRow) => {
    const now = new Map(current.map((r) => [r[idCol], r]));
    const savedById = new Map(saved.map((r) => [r[idCol], r]));
    const order = saved.length ? saved.map((r) => r[idCol]) : planIds;
    const out: CleanRow[] = [];
    for (const id of order) {
      if (now.has(id)) { out.push(now.get(id)!); now.delete(id); }
      else if (planIds.includes(id)) {
        const row = savedById.has(id) ? structuredClone(savedById.get(id)!) : rebuild(id);
        out.push(row);
        restored.push(row.table_label || row.fam_label || id);
      }
    }
    return out.concat(current.filter((r) => now.has(r[idCol])));
  };
  const hosts = new Map(s.plan.hosts.map((h) => [h.hostId, h]));
  const fams = new Map(s.plan.fams.map((f) => [f.groupId, f]));
  s.hosts = merge(s.hosts, snap.hosts, [...hosts.keys()], "host_id", (i) => {
    const h = hosts.get(i)!;
    return { host_id: i, table_label: h.name, host_name: h.person, tags: h.tags.join("; ") };
  });
  s.fams = merge(s.fams, snap.fams, [...fams.keys()], "fam_id", (i) => {
    const f = fams.get(i)!;
    return { fam_id: i, table_number: String(f.tableNumber || ""), fam_label: f.name, size: String(f.size || ""),
      interests: f.interests.join("; "), students: f.members.join("; ") };
  });
  return restored;
}

export function removedRows(s: EventState): string[] {
  if (!s.plan) return [];
  const hostIds = new Set(cleanRows(s.hosts).map((r) => r.host_id));
  const famIds = new Set(cleanRows(s.fams).map((r) => r.fam_id));
  return [...s.plan.hosts.filter((h) => !hostIds.has(h.hostId)).map((h) => h.name),
    ...s.plan.fams.filter((f) => !famIds.has(f.groupId)).map((f) => f.name)];
}

// ----------------------------------------------------------------------
// Near-miss tags.
// ----------------------------------------------------------------------

export function tagKey(tag: string): string {
  let k = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (k.length > 3 && k.endsWith("s") && !k.endsWith("ss")) k = k.slice(0, -1);
  return k;
}

export interface NearMiss { spellings: string[]; suggestion: string }

export function nearMisses(hostRows: Iterable<Row>, famRows: Iterable<Row>): NearMiss[] {
  const hostCount = new Map<string, number>();
  const famCount = new Map<string, number>();
  for (const r of cleanRows(hostRows)) for (const t of new Set(splitTags(r.tags ?? ""))) hostCount.set(t, (hostCount.get(t) ?? 0) + 1);
  for (const r of cleanRows(famRows)) for (const t of new Set(splitTags(r.interests ?? ""))) famCount.set(t, (famCount.get(t) ?? 0) + 1);
  const groups = new Map<string, Set<string>>();
  for (const t of new Set([...hostCount.keys(), ...famCount.keys()])) {
    const k = tagKey(t);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)!.add(t);
  }
  for (const short of [...groups.keys()].sort((a, b) => a.length - b.length)) {
    if (short.length < 4 || !groups.has(short) || [...groups.get(short)!].some((t) => t.includes(" "))) continue;
    const longer = [...groups.keys()].filter((k) => k !== short && k.startsWith(short) && ![...groups.get(k)!].some((t) => t.includes(" ")));
    if (longer.length === 1) {
      for (const t of groups.get(short)!) groups.get(longer[0])!.add(t);
      groups.delete(short);
    }
  }
  const out: NearMiss[] = [];
  for (const k of [...groups.keys()].sort()) {
    const spellings = groups.get(k)!;
    if (spellings.size < 2) continue;
    if (![...spellings].some((s) => hostCount.has(s)) || ![...spellings].some((s) => famCount.has(s))) continue;
    const total = (s: string) => (hostCount.get(s) ?? 0) + (famCount.get(s) ?? 0);
    const rank = (s: string): [number, number, number, string] => [-total(s), s.endsWith("s") && spellings.has(s.slice(0, -1)) ? 1 : 0, -s.length, s];
    const best = [...spellings].sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return (ra[i] as number) - (rb[i] as number);
      return ra[3] < rb[3] ? -1 : ra[3] > rb[3] ? 1 : 0;
    })[0];
    out.push({ spellings: [...spellings].sort(), suggestion: best });
  }
  return out;
}

export function applySpelling(s: EventState, miss: NearMiss): void {
  const fix = (text: string) => [...new Set(splitTags(text).map((t) => (miss.spellings.includes(t) ? miss.suggestion : t)))].join("; ");
  for (const r of s.hosts) r.tags = fix(r.tags ?? "");
  for (const r of s.fams) r.interests = fix(r.interests ?? "");
}

// ----------------------------------------------------------------------
// Event files.
// ----------------------------------------------------------------------

function planToDict(p: EventPlan | null): unknown {
  if (!p) return null;
  return {
    hosts: p.hosts.map((h) => ({ id: h.hostId, name: h.name, theme: h.theme, tags: h.tags, person: h.person })),
    fams: p.fams.map((f) => ({ id: f.groupId, name: f.name, interests: f.interests, size: f.size, table_number: f.tableNumber, members: f.members })),
    rounds: p.rounds,
    assignments: p.assignments.map((a) => [a.round, a.hostId, a.groupId, a.score]),
    free_rounds: p.freeRounds,
    host_breaks: p.hostBreaks,
    total_score: p.totalScore,
    objective_bound: p.objectiveBound,
    objective_value: p.objectiveValue,
    kept_slots: p.keptSlots,
    runtime_s: p.runtimeS,
    warnings: p.warnings,
    rules: p.rules.map((r) => [r.kind, r.hostId, r.famId, r.rounds]),
    host_away: p.hostAway,
    host_limits: p.hostLimits,
    fam_away: p.famAway,
    locked_rounds: p.lockedRounds,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function planFromDict(d: any): EventPlan | null {
  if (d === null || d === undefined) return null;
  return {
    hosts: d.hosts.map((h: any) => makeHost(h.id, h.name, h.theme, h.tags, h.person ?? "")),
    fams: d.fams.map((f: any) => makeGroup(f.id, f.name, f.interests, { size: f.size, tableNumber: f.table_number, members: f.members ?? [] })),
    rounds: d.rounds,
    assignments: d.assignments.map(([r, h, g, sc]: [number, string, string, number]): Assignment => ({ round: r, hostId: h, groupId: g, score: sc })),
    freeRounds: d.free_rounds,
    hostBreaks: d.host_breaks,
    totalScore: d.total_score,
    objectiveBound: d.objective_bound,
    runtimeS: d.runtime_s,
    warnings: d.warnings,
    rules: d.rules.map(([k, h, f, rs]: [string, string, string, number[]]) => ({ kind: k, hostId: h, famId: f, rounds: rs })),
    hostAway: d.host_away,
    hostLimits: d.host_limits ?? {},
    famAway: d.fam_away,
    lockedRounds: d.locked_rounds,
    objectiveValue: d.objective_value,
    keptSlots: d.kept_slots,
  };
}

export function saveEvent(s: EventState): string {
  return JSON.stringify({
    format: FILE_FORMAT,
    version: FILE_VERSION,
    title: s.title,
    rounds: s.rounds,
    hosts: s.hosts,
    fams: s.fams,
    rules: s.rules,
    finished: s.finished,
    cancel_hosts: s.cancelHosts,
    cancel_fams: s.cancelFams,
    plan: planToDict(s.plan),
    plan_inputs: s.planInputs,
    printed: planToDict(s.printed),
    one_weak_round: s.oneWeakRound,
    plan_tables: s.planTables,
    start_time: s.startTime,
    round_minutes: s.roundMinutes,
    // Written only when changed, so files from before these settings read the same.
    ...(s.switchMinutes !== 5 ? { switch_minutes: s.switchMinutes } : {}),
    ...(s.openMinutes ? { open_minutes: s.openMinutes } : {}),
    printed_at: s.printedAt,
    arrived: s.arrived,
    notes: s.notes,
    night_log: s.nightLog,
    night: s.night,
  }, null, 2);
}

const NOT_EVENT = "That file is not a saved event. Choose a file saved with Save event file.";

export function loadEvent(text: string): EventState {
  let d: any;
  try { d = JSON.parse(text); } catch { throw new SheetError([NOT_EVENT]); }
  if (!d || typeof d !== "object" || d.format !== FILE_FORMAT) throw new SheetError([NOT_EVENT]);
  if (d.version !== FILE_VERSION) throw new SheetError([`That event was saved by a different version of this tool (file version ${d.version}).`]);
  try {
    const intMap = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number(v)]));
    if (!("title" in d) || !Array.isArray(d.hosts) || !Array.isArray(d.fams) || !Array.isArray(d.rules)) throw new Error();
    return newEvent({
      title: String(d.title), rounds: Number(d.rounds), hosts: d.hosts, fams: d.fams, rules: d.rules,
      finished: Number(d.finished), cancelHosts: intMap(d.cancel_hosts), cancelFams: intMap(d.cancel_fams),
      plan: planFromDict(d.plan), planInputs: d.plan_inputs, printed: planFromDict(d.printed),
      oneWeakRound: !!d.one_weak_round, planTables: d.plan_tables ?? null, startTime: String(d.start_time ?? ""),
      roundMinutes: Number(d.round_minutes ?? 20), switchMinutes: Number(d.switch_minutes ?? 5), openMinutes: Number(d.open_minutes ?? 0), printedAt: String(d.printed_at ?? ""),
      arrived: (d.arrived ?? []).map(String), notes: String(d.notes ?? ""),
      nightLog: (d.night_log ?? []).map((e: any) => ({ at: String(e.at ?? ""), text: String(e.text ?? "") })),
      night: d.night && typeof d.night === "object" && !Array.isArray(d.night) ? d.night : {},
    });
  } catch {
    throw new SheetError(["That saved event is incomplete or damaged, so it cannot be loaded."]);
  }
}

/** Next year's copy: the same tables and rules, without student names or the night. */
/** A rule worth keeping for next year (see event.py). */
function lasts(r: CleanRow): boolean {
  const kind = (r.rule ?? "").toLowerCase();
  if (r.by === "grid" || kind === "only in rounds") return false;
  return !((kind === "must meet" || kind === "never meet") && (r.rounds ?? "").trim());
}

export function handoffEvent(s: EventState): EventState {
  return newEvent({
    title: s.title, rounds: s.rounds, hosts: structuredClone(s.hosts),
    // Tables moved on the night go back to where they were planned.
    fams: s.fams.map((r) => ({ ...r, ...(s.night.tablesBefore?.[r.fam_id] ?? {}), students: "" })),
    rules: structuredClone(s.rules.filter(lasts)), oneWeakRound: s.oneWeakRound, startTime: s.startTime, roundMinutes: s.roundMinutes,
    switchMinutes: s.switchMinutes, openMinutes: s.openMinutes, notes: s.notes,
  });
}

export function isPrinted(s: EventState): boolean {
  if (!s.printed || !s.plan || s.printed.rounds !== s.plan.rounds) return false;
  const a = slots(s.printed), b = slots(s.plan);
  return a.size === b.size && [...a].every((x) => b.has(x));
}

export interface CheckItem { status: "done" | "todo" | "optional"; text: string }

export function beforeTheNight(s: EventState, saved: boolean): CheckItem[] {
  const inputs = checkInputs(s);
  const items: CheckItem[] = [];
  const add = (ok: boolean, done: string, todo: string, optional = false) =>
    items.push({ status: ok ? "done" : optional ? "optional" : "todo", text: ok ? done : todo });
  const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? "s" : ""}`;
  const { hosts, fams } = inputs;
  add(!inputs.problems.length, "The tables and rules have no problems.",
    `Fix the ${inputs.problems.length} problem${inputs.problems.length !== 1 ? "s" : ""} listed under Please fix these first.`);
  const noTags = hosts.filter((h) => !h.tags.length).map((h) => h.name);
  add(!!hosts.length && !noTags.length, `All ${hosts.length} host tables have tags.`,
    `Add tags for ${plural(noTags.length, "host table")}: ${noTags.slice(0, 5).join(", ")}${noTags.length > 5 ? "…" : ""}.`);
  const noInterests = fams.filter((f) => !f.interests.length).map((f) => f.name);
  add(!!fams.length && !noInterests.length, `All ${fams.length} fams have interests.`,
    `Add interests for ${plural(noInterests.length, "fam")}: ${noInterests.slice(0, 5).join(", ")}${noInterests.length > 5 ? "…" : ""}.`);
  add(isCurrent(s), "The schedule is up to date.", "Find the best schedule (or re-plan): the schedule is missing or out of date.");
  if (s.plan && isCurrent(s)) {
    const unfair = s.plan.warnings.filter((w) => w.startsWith("Fairness check"));
    add(!unfair.length, "Every fam gets a fair share of matching hosts, and every host table gets a fam.",
      `Look at the ${unfair.length} fairness check${unfair.length !== 1 ? "s" : ""} under the schedule.`, true);
  }
  add(!!hosts.length && hosts.every((h) => h.person), "Every host table has an alum's name for the host cards.",
    "Add alum names so host cards say who hosts each table.", true);
  add(!!fams.length && fams.every((f) => f.members.length), "Every fam has student names for the find-your-table page.",
    "Add student names to print a find-your-table page.", true);
  add(isPrinted(s), "The printed version is marked.", "Print the four documents, then click Mark as printed.");
  add(saved, "The event file is saved with every change.", "Click Save event file in the sidebar and keep the file for the night.");
  return items;
}

export { InfeasibleProblemError, provenOptimal };
