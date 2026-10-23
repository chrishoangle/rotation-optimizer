// Pasting rows copied from a spreadsheet into the host and fam tables.

/**
 * Cells copied from Google Sheets or Excel arrive as tab separated lines, with
 * quotes around a cell that holds a tab, a line break, or a quote. Returns
 * null for a single value, which the browser pastes as usual.
 */
export function parsePasted(text: string): string[][] | null {
  const s = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!s.includes("\t") && !s.includes("\n")) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  while (i <= s.length) {
    if (cell === "" && s[i] === '"') {
      let j = i + 1;
      let quoted = "";
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') { quoted += '"'; j += 2; }
        else if (s[j] === '"') break;
        else quoted += s[j++];
      }
      if (j < s.length && (j + 1 === s.length || s[j + 1] === "\t" || s[j + 1] === "\n")) {
        cell = quoted.replace(/\n/g, " ");
        i = j + 1;
        continue;
      }
    }
    const ch = s[i];
    if (ch === undefined || ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else if (ch === "\t") { row.push(cell.trim()); cell = ""; }
    else cell += ch;
    i++;
  }
  const kept = rows.filter((r) => r.some((c) => c));
  return kept.length ? kept : null;
}

const HEADER_WORDS = [
  "alum", "alums", "alumni", "alum's name", "alum name", "name", "your name", "full name", "host", "host name", "host table", "host table name",
  "topic", "topic (optional)", "table", "table #", "table number", "table name", "fam", "fam name", "family", "group", "students",
  "students (optional)", "student names", "size", "how many students", "tags", "interests", "fields", "can talk about", "interested in",
  "location", "location in the room", "where in the room", "step-free", "step-free?", "step-free access", "timestamp", "email", "email address",
];
const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ").replace(/[:.]$/, "");

/**
 * Whether a pasted first row is a header, not data: no cell is a number, and
 * at least two cells are column names a spreadsheet would use.
 */
export function looksLikeHeader(cells: string[]): boolean {
  if (cells.some((c) => /^\d+$/.test(c.trim()))) return false;
  return cells.filter((c) => HEADER_WORDS.includes(norm(c))).length >= 2;
}
