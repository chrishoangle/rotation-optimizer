// Reading what a coordinator already has, as they have it.
//
// Two shapes come up again and again. A seating chart: one row per fam table
// and one column per round, with the alumni (alone or "A + B") in each cell.
// And an alumni list from a sign-up form or a doc: a name, often an email,
// and a line about what they do. Neither is a file this app made, and both
// are usually copied from Google Docs, Sheets, or Excel.

import { peopleIn } from "./faces";
import { careerWords, majorWords } from "./words";

export interface SeatingChart {
  rounds: number;
  fams: { table: string; name: string; interests: string[] }[];
  /** Each alumni table once, as "A & B" for a pair. */
  hosts: string[];
  /** Who sat where: fam name, round, alumni table. */
  seats: { fam: string; round: number; host: string }[];
}

/** The same alum or pair however they were written: "Ann Lee + Bo Kim" and "Bo Kim & Ann Lee". */
export const pairKey = (who: string) => peopleIn(who).map((x) => x.toLowerCase()).sort().join("|");
const tidyPeople = (cell: string) => peopleIn(cell.replace(/\s+/g, " ")).join(" & ");

/** One fam cell: "Table 1 Fam 6 (PoliSci/Comm/Public Affairs)", across one line or several. */
export function readFamCell(cell: string, row: number): { table: string; name: string; interests: string[] } {
  const text = cell.replace(/\s+/g, " ").trim();
  const table = /\btable\s*#?\s*(\d+)/i.exec(text)?.[1] ?? "";
  const paren = /\(([^)]*)\)/.exec(text)?.[1] ?? "";
  let name = text.replace(/\btable\s*#?\s*\d+/i, "").replace(/\([^)]*\)/g, "").replace(/[\s:,-]+$/, "").replace(/^[\s:,-]+/, "").trim();
  let interests = majorWords(paren);
  if (!paren) {
    // "Fam 6 - PoliSci/Comm" or "Fam 6: PoliSci": the words after the fam's own name.
    const m = /^(fam(?:ily)?\s*\S+)\s*[-:–]?\s*(.*)$/i.exec(name);
    if (m && m[2]) { name = m[1]; interests = majorWords(m[2]); }
  }
  return { table: table || String(row), name: name || `Table ${table || row}`, interests };
}

/**
 * A grid with "Round 1", "Round 2", … in its first row is a seating chart.
 * Returns null for anything else, so ordinary lists are read as before.
 */
export function readSeatingChart(grid: string[][]): SeatingChart | null {
  const head = grid.findIndex((r) => r.filter((c) => /\bround\s*\d+/i.test(c)).length >= 1);
  if (head < 0 || head > 2) return null;
  const header = grid[head];
  const roundCols = header.map((c, i) => [i, Number(/\bround\s*(\d+)/i.exec(c)?.[1] ?? 0)] as const).filter(([, n]) => n > 0);
  if (!roundCols.length) return null;
  const famCol = header.findIndex((c, i) => !roundCols.some(([j]) => j === i));
  if (famCol < 0) return null;
  const fams: SeatingChart["fams"] = [];
  const hosts = new Map<string, string>();
  const seats: SeatingChart["seats"] = [];
  grid.slice(head + 1).filter((r) => (r[famCol] ?? "").trim()).forEach((r, k) => {
    const fam = readFamCell(r[famCol], k + 1);
    fams.push(fam);
    for (const [col, round] of roundCols) {
      const who = tidyPeople(r[col] ?? "");
      if (!who) continue;
      if (!hosts.has(pairKey(who))) hosts.set(pairKey(who), who);
      seats.push({ fam: fam.name, round, host: hosts.get(pairKey(who))! });
    }
  });
  if (!fams.length || !hosts.size) return null;
  return { rounds: Math.max(...roundCols.map(([, n]) => n)), fams, hosts: [...hosts.values()], seats };
}

export interface ListedAlum { name: string; about: string; interests: string[] }

const EMAIL = /[^\s,;<>()]+@[^\s,;<>()]+\.[a-z]{2,}/i;

/**
 * An alumni list as people keep it: "Name: email" (or "Name, email", or just
 * a name) on one line and what they do on the next. Emails are dropped.
 * Returns null unless most entries carry an email, so a plain "name,
 * interests" list, or rows copied from a spreadsheet, are read the ordinary way.
 */
export function readAlumniList(text: string): ListedAlum[] | null {
  if ((text ?? "").includes("\t")) return null; // rows from a spreadsheet are read by their columns instead
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const out: ListedAlum[] = [];
  let withEmail = 0;
  for (const line of lines) {
    const email = EMAIL.exec(line);
    if (email) {
      const name = line.slice(0, email.index).replace(/[\s:,;<(-]+$/, "").trim();
      if (name) { out.push({ name, about: "", interests: [] }); withEmail++; continue; }
    }
    const last = out[out.length - 1];
    if (last && !last.about) last.about = line.replace(EMAIL, "").replace(/^[\s:,-]+|[\s,]+$/g, "");
    else if (last) last.about += `; ${line}`;
  }
  if (out.length < 2 || withEmail < out.length * 0.6) return null;
  for (const a of out) a.interests = careerWords(a.about);
  return out;
}
