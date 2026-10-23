// Reading the tables a coordinator fills in. A port of
// src/rotation_optimizer/sheets.py: same columns, same checks, same words.

import { GuestGroup, Host, makeGroup, makeHost } from "./models";
import { csvLine, pyRepr } from "./py";

export type Row = Record<string, unknown>;
export type CleanRow = Record<string, string>;

export class SheetError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

/** One spreadsheet cell as clean text. Missing values and blanks become "". */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "";
    if (Number.isInteger(value)) return String(value);
  }
  return String(value).trim();
}

export const FRIENDLY: Record<string, string> = {
  table_label: "Host table name",
  host_name: "Alum's name",
  tags: "Tags",
  table_number: "Table number",
  fam_label: "Fam name",
  size: "Size",
  interests: "Interests",
  students: "Students",
  location: "Location in the room",
  step_free: "Step-free access",
};
export const FILE_COLUMNS: Record<"hosts" | "fams", string[]> = {
  hosts: ["table_label", "host_name", "tags"],
  fams: ["table_number", "fam_label", "size", "interests", "students", "location", "step_free"],
};
export const REQUIRED: Record<"hosts" | "fams", string[]> = { hosts: ["table_label"], fams: ["fam_label"] };
export const EXAMPLE_MARK = "(example)";
export type Kind = "hosts" | "fams";

export function key(text: string): string {
  return String(text).toLowerCase().replace(/[^a-z0-9#]+/g, "");
}

const FRIENDLY_KEYS: Record<string, string> = Object.fromEntries(Object.entries(FRIENDLY).map(([k, v]) => [key(v), k]));

/** Normalize headers and cells, and drop rows that are blank in every cell. Friendly headers become ours. */
export function cleanRows(rows: Iterable<Row>): CleanRow[] {
  const out: CleanRow[] = [];
  for (const raw of rows) {
    const row: CleanRow = {};
    for (const [k, v] of Object.entries(raw)) row[FRIENDLY_KEYS[key(k)] ?? k.trim().toLowerCase()] = cell(v);
    if (Object.values(row).some((v) => v)) out.push(row);
  }
  return out;
}

export function splitTags(text: string): string[] {
  return text.replace(/,/g, ";").split(";").map((t) => t.trim().toLowerCase()).filter((t) => t);
}

export function splitTagsKeepCase(text: string): string[] {
  return text.replace(/,/g, ";").split(";").map((t) => t.trim()).filter((t) => t);
}

function who(kind: "host" | "fam", i: number, label: string): string {
  if (label) return label;
  return `The ${kind === "host" ? "host table" : "fam"} in row ${i}`;
}

function pyInt(text: string): number | null {
  return /^[+-]?\d+$/.test(text) ? parseInt(text, 10) : null;
}

export function hostsFromRows(rows: Iterable<Row>): [Host[], string[], string[]] {
  const problems: string[] = [];
  const warnings: string[] = [];
  const hosts: Host[] = [];
  const clean = cleanRows(rows);
  const usedIds = new Set(clean.map((r) => r.host_id ?? "").filter((x) => x));
  const seenIds = new Set<string>();
  const labels = new Map<string, number>();
  const blank: string[] = [];
  let nextId = 1;
  clean.forEach((row, idx) => {
    const i = idx + 1;
    const label = row.table_label ?? "";
    const w = who("host", i, label);
    let hostId = row.host_id ?? "";
    if (!hostId) {
      while (usedIds.has(`h${String(nextId).padStart(2, "0")}`)) nextId++;
      hostId = `h${String(nextId).padStart(2, "0")}`;
      usedIds.add(hostId);
    }
    const tags = splitTags(row.tags ?? "");
    if (!label) problems.push(`Row ${i} of the host tables has no table name. Add one, or delete the row.`);
    else if (labels.has(label.toLowerCase())) problems.push(`Two host tables are named ${label}. Each table needs its own name.`);
    else labels.set(label.toLowerCase(), i);
    if (seenIds.has(hostId)) problems.push(`${w} has the same row ID (${hostId}) as an earlier row. Delete the copy, or clear the ID in one of them.`);
    seenIds.add(hostId);
    if (!tags.length) blank.push(w);
    hosts.push(makeHost(hostId, label, label, tags, row.host_name ?? ""));
  });
  if (!hosts.length) problems.push("Add at least one host table.");
  if (blank.length && blank.length === hosts.length && hosts.length > 1) {
    warnings.push("No host table has tags yet, so every pairing scores 0. Add tags to match hosts to fams. You can still plan.");
  } else {
    for (const w of blank) warnings.push(`${w} has no tags yet, so it scores 0 with every fam. You can still plan.`);
  }
  return [hosts, problems, warnings];
}

export function famsFromRows(rows: Iterable<Row>): [GuestGroup[], string[], string[]] {
  const problems: string[] = [];
  const warnings: string[] = [];
  const built: [string, string, string[], number, number | null, string[]][] = [];
  const clean = cleanRows(rows);
  const usedIds = new Set(clean.map((r) => r.fam_id ?? "").filter((x) => x));
  const seenIds = new Set<string>();
  const labels = new Map<string, number>();
  const numbers = new Map<number, string>();
  const blank: string[] = [];
  let nextId = 1;
  clean.forEach((row, idx) => {
    const i = idx + 1;
    const label = row.fam_label ?? "";
    const w = who("fam", i, label);
    let famId = row.fam_id ?? "";
    if (!famId) {
      while (usedIds.has(`fam_${String(nextId).padStart(2, "0")}`)) nextId++;
      famId = `fam_${String(nextId).padStart(2, "0")}`;
      usedIds.add(famId);
    }
    const interests = splitTags(row.interests ?? "");
    let size = 0;
    if (row.size) {
      const n = pyInt(row.size);
      if (n === null) problems.push(`${w}: the size ${pyRepr(row.size)} is not a whole number.`);
      else size = n;
    }
    let number: number | null = null;
    if (row.table_number) {
      const n = pyInt(row.table_number);
      if (n === null || n < 1) problems.push(`${w}: the table number ${pyRepr(row.table_number)} is not a whole number from 1 up.`);
      else number = n;
    }
    if (number !== null) {
      if (numbers.has(number)) problems.push(`${numbers.get(number)} and ${w} both use table number ${number}. Each fam needs its own table number.`);
      else numbers.set(number, w);
    }
    if (!label) problems.push(`Row ${i} of the fams has no fam name. Add one, or delete the row.`);
    else if (labels.has(label.toLowerCase())) problems.push(`Two fams are named ${label}. Each fam needs its own name.`);
    else labels.set(label.toLowerCase(), i);
    if (seenIds.has(famId)) problems.push(`${w} has the same row ID (${famId}) as an earlier row. Delete the copy, or clear the ID in one of them.`);
    seenIds.add(famId);
    if (!interests.length) blank.push(w);
    built.push([famId, label, interests, size, number, splitTagsKeepCase(row.students ?? "")]);
  });
  if (!built.length) problems.push("Add at least one fam.");
  if (blank.length && blank.length === built.length && built.length > 1) {
    warnings.push("No fam has interests yet, so every pairing scores 0. Add interests to match fams to hosts. You can still plan.");
  } else {
    for (const w of blank) warnings.push(`${w} has no interests yet, so it scores 0 with every host. You can still plan.`);
  }
  const fams: GuestGroup[] = [];
  let nextNumber = 1;
  for (const [famId, label, interests, size, num, members] of built) {
    let number = num;
    if (number === null) {
      while (numbers.has(nextNumber)) nextNumber++;
      number = nextNumber;
      numbers.set(number, label);
    }
    fams.push(makeGroup(famId, label, interests, { size, tableNumber: number, members }));
  }
  return [fams, problems, warnings];
}

export function hostIdByLabel(hosts: Host[], label: string): string {
  const want = label.trim().toLowerCase();
  const h = hosts.find((x) => x.name.toLowerCase() === want);
  if (!h) throw new SheetError([`No host table named ${pyRepr(label)}.`]);
  return h.hostId;
}

export function famIdByLabel(fams: GuestGroup[], label: string): string {
  const want = label.trim().toLowerCase();
  const f = fams.find((x) => x.name.toLowerCase() === want);
  if (!f) throw new SheetError([`No fam named ${pyRepr(label)}.`]);
  return f.groupId;
}

export const RULE_KINDS: Record<string, "must" | "never" | "only" | "stays" | "access"> = {
  "must meet": "must", "never meet": "never", "only in rounds": "only", "stays with": "stays",
  "needs step-free": "access",
};

const PY_FLOAT = /^[+-]?((\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?|inf(inity)?|nan)$/i;

/** Read "1", "1,2", "1;2", "1 2", or "1 and 2" as round numbers. Blank means none. Throws Error with a plain message. */
export function parseRounds(text: string, rounds: number): number[] {
  const t = cell(text);
  if (!t) return [];
  const parts = t.split(/[,;\s]+|\band\b/).filter((p) => p && p.trim());
  const out: number[] = [];
  for (const part of parts) {
    if (!PY_FLOAT.test(part.trim())) throw new Error(`${pyRepr(t)} is not a list of round numbers like 1, 2`);
    const value = Number(part.trim().replace(/_/g, "").replace(/^([+-]?)inf(inity)?$/i, "$1Infinity"));
    if (!Number.isInteger(value)) throw new Error(`${pyRepr(t)} is not a list of round numbers like 1, 2`);
    if (value < 1 || value > rounds) {
      throw new Error(`there is no round ${value}, the event has ${rounds} round${rounds !== 1 ? "s" : ""}`);
    }
    out.push(value);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface Rule {
  kind: "must" | "never" | "stays" | "access";
  hostId: string;
  famId: string;
  rounds: number[];
}

/** The rules table as rules plus "only in rounds" availability. Throws SheetError listing every problem. */
export function parseRuleRows(rows: Iterable<Row>, hosts: Host[], fams: GuestGroup[], rounds: number): [Rule[], Record<string, number[]>] {
  const problems: string[] = [];
  const rules: Rule[] = [];
  const hostAway: Record<string, number[]> = {};
  cleanRows(rows).forEach((row, idx) => {
    const i = idx + 1;
    const kind = RULE_KINDS[(row.rule ?? "").toLowerCase()];
    if (!kind) { problems.push(`Pairing rule ${i}: choose must meet, never meet, only in rounds, stays with, or needs step-free.`); return; }
    let h: string;
    try { h = hostIdByLabel(hosts, row.host_table ?? ""); } catch { problems.push(`Pairing rule ${i}: choose a host table from the list.`); return; }
    let rs: number[];
    try { rs = parseRounds(row.rounds ?? "", rounds); } catch (err) { problems.push(`Pairing rule ${i}: ${(err as Error).message}.`); return; }
    if (kind === "only") {
      if (!rs.length) { problems.push(`Pairing rule ${i}: only in rounds needs at least one round.`); return; }
      const keep = new Set(rs);
      hostAway[h] = Array.from({ length: rounds }, (_, k) => k + 1).filter((r) => !keep.has(r));
      return;
    }
    if (kind === "access") {
      if (rs.length || (row.fam ?? "").trim()) { problems.push(`Pairing rule ${i}: needs step-free applies to every table, so leave Fam and Rounds blank.`); return; }
      rules.push({ kind: "access", hostId: h, famId: "", rounds: [] });
      return;
    }
    if (kind === "stays") {
      if (rs.length) { problems.push(`Pairing rule ${i}: stays with is for the whole night, so leave Rounds blank.`); return; }
      if (!(row.fam ?? "").trim()) { rules.push({ kind: "stays", hostId: h, famId: "", rounds: [] }); return; }
    }
    let f: string;
    try { f = famIdByLabel(fams, row.fam ?? ""); } catch { problems.push(`Pairing rule ${i}: choose a fam from the list.`); return; }
    rules.push({ kind, hostId: h, famId: f, rounds: rs });
  });
  if (problems.length) throw new SheetError(problems);
  return [rules, Object.fromEntries(Object.entries(hostAway).filter(([, rs]) => rs.length))];
}

// ----------------------------------------------------------------------
// Matching an uploaded file's columns to ours.
// ----------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  table_label: ["table", "table name", "host table", "career", "field", "theme", "topic"],
  host_name: ["name", "alum", "alum name", "alumni", "alumnus", "host", "host name", "full name", "your name"],
  tags: ["tag", "keywords", "topics", "interests", "areas", "expertise", "fields"],
  fam_label: ["fam", "group", "group name", "family", "family name"],
  interests: ["interest", "majors", "major", "keywords", "tags", "topics", "fields"],
  table_number: ["table", "table no", "table #", "number"],
  students: ["student", "student name", "names", "members", "admits", "student names", "name", "your name", "full name"],
  size: ["count", "students count", "number of students", "how many"],
  location: ["location", "where", "where in the room", "zone", "spot", "room location"],
  step_free: ["step free", "stepfree", "accessible", "wheelchair accessible", "access", "accessibility"],
};

const HINTS: Record<Kind, [string, string[], string[]][]> = {
  hosts: [
    ["table_label", ["table name", "host table", "career", "industry", "field", "table"], []],
    ["host_name", ["name"], ["table", "fam", "group"]],
    ["tags", ["tag", "keyword", "topic", "interest", "expertise", "area", "talk about", "subject"], []],
  ],
  fams: [
    ["table_number", ["table number", "table #", "table no", "table"], ["name"]],
    ["fam_label", ["fam", "family", "group"], ["number", "size", "how many"]],
    ["size", ["size", "how many"], []],
    ["interests", ["interest", "major", "tag", "keyword", "topic"], []],
    ["students", ["student", "name", "admit"], []],
  ],
};

const NEVER = ["timestamp", "email", "e mail", "phone", "score"];

function words(text: string): string {
  return " " + String(text).toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim() + " ";
}

/** Guess which column in a file holds each of ours. Returns {our column: file column}. */
export function matchColumns(columns: Iterable<string>, kind: Kind): Record<string, string> {
  const found = [...columns].filter((c) => c && String(c).trim() && !NEVER.some((n) => words(c).includes(" " + n + " ")));
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  const take = (ours: string, theirs: string) => { mapping[ours] = theirs; used.add(theirs); };
  const ours = FILE_COLUMNS[kind];
  for (const o of ours) {
    const c = found.find((c) => !used.has(c) && (key(c) === key(o) || key(c) === key(FRIENDLY[o])));
    if (c !== undefined) take(o, c);
  }
  for (const o of ours) {
    if (o in mapping) continue;
    const names = new Set((SYNONYMS[o] ?? []).map(key));
    const c = found.find((c) => !used.has(c) && names.has(key(c)));
    if (c !== undefined) take(o, c);
  }
  for (const [o, include, exclude] of HINTS[kind]) {
    if (o in mapping) continue;
    for (const c of found) {
      const w = words(c);
      if (used.has(c) || exclude.some((x) => w.includes(words(x).trim()))) continue;
      if (include.some((x) => w.includes(" " + words(x).trim() + " ") || (x.length > 4 && w.includes(x)))) {
        take(o, c);
        break;
      }
    }
  }
  // Python dicts keep insertion order; callers only look values up by key.
  return mapping;
}

/** Problems (required columns with no match) and notices (optional columns with no match). */
export function columnReport(columns: string[], kind: Kind, mapping?: Record<string, string>): [string[], string[], Record<string, string>] {
  const found = columns.filter((c) => c && String(c).trim());
  const m = Object.fromEntries(Object.entries(mapping ?? matchColumns(found, kind)).filter(([, v]) => v));
  const listing = found.join(", ") || "none";
  const problems: string[] = [];
  const notices: string[] = [];
  for (const col of REQUIRED[kind]) {
    if (!(col in m)) problems.push(`Choose the column in your file that holds the ${FRIENDLY[col].toLowerCase()}. Columns found: ${listing}.`);
  }
  const what: Record<string, string> = {
    tags: "every host will score 0 until you add tags",
    interests: "every fam will score 0 until you add interests",
    host_name: "host cards will show only the table name",
    students: "the find-your-table page will be empty",
    table_number: "tables will be numbered 1, 2, 3 in file order",
    size: "fam sizes will be counted from the students, or left blank",
  };
  for (const col of FILE_COLUMNS[kind]) {
    if (!(col in m) && !REQUIRED[kind].includes(col) && col in what) notices.push(`No ${FRIENDLY[col].toLowerCase()} column, so ${what[col]}.`);
  }
  return [problems, notices, m];
}

/** Keep only the matched columns, renamed to ours. Unmatched columns, such as email, are dropped. */
export function renameColumns(rows: Record<string, string>[], mapping: Record<string, string>): Record<string, string>[] {
  return rows.map((r) => Object.fromEntries(Object.entries(mapping).filter(([, t]) => t).map(([o, t]) => [o, r[t] ?? ""])));
}

export function dropExampleRows(rows: Record<string, string>[]): [Record<string, string>[], number] {
  const kept = rows.filter((r) => !Object.values(r).some((v) => cell(v).toLowerCase().startsWith(EXAMPLE_MARK)));
  return [kept, rows.length - kept.length];
}

/** One row per student becomes one row per fam, when fam names repeat and each row has one student. */
export function groupStudentRows(rows: Record<string, string>[]): [Record<string, string>[], number] {
  const names = rows.map((r) => cell(r.fam_label ?? "").toLowerCase()).filter((x) => x);
  const students = rows.map((r) => cell(r.students ?? ""));
  const oneEach = students.filter((x) => x).length >= rows.length / 2 && !students.some((x) => x.includes(";"));
  if (names.length === new Set(names).size || !oneEach) return [rows, 0];
  const fams = new Map<string, { fam_label: string; table_number: string; interests: string[]; students: string[] }>();
  let count = 0;
  for (const r of rows) {
    const label = cell(r.fam_label ?? "");
    if (!label) continue;
    let fam = fams.get(label.toLowerCase());
    if (!fam) { fam = { fam_label: label, table_number: "", interests: [], students: [] }; fams.set(label.toLowerCase(), fam); }
    if (!fam.table_number && cell(r.table_number ?? "")) fam.table_number = cell(r.table_number ?? "");
    for (const t of splitTagsKeepCase(cell(r.interests ?? ""))) {
      if (!fam.interests.some((x) => x.toLowerCase() === t.toLowerCase())) fam.interests.push(t);
    }
    const s = cell(r.students ?? "");
    if (s) { fam.students.push(s); count++; }
  }
  const out = [...fams.values()].map((f) => ({
    table_number: f.table_number,
    fam_label: f.fam_label,
    size: f.students.length ? String(f.students.length) : "",
    interests: f.interests.join("; "),
    students: f.students.join("; "),
  }));
  return [out, count];
}

export function templateCsv(kind: Kind): string {
  const example = {
    hosts: ["(example) Physician (MD)", "Alum A", "medicine; healthcare; pre-med"],
    fams: ["1", "(example) Bio & Chem", "6", "biology; chemistry; pre-med", "Student 01; Student 02", "by the stage", "yes"],
  }[kind];
  return csvLine(FILE_COLUMNS[kind].map((c) => FRIENDLY[c])) + "\r\n" + csvLine(example) + "\r\n";
}
