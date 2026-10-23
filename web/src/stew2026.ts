// The example dinner: the STEW 2026 family dinner as it really ran, used by
// "See the STEW 2026 dinner", the walkthrough, and the example rows beside each
// paste box. Real alumni, included at the maintainer's decision: names and
// what each does only. No contact details, employers, or schools.

import type { EventState } from "./event";
import { newEvent, normalizeState } from "./event";
import { placeInGrid } from "./people";
import { careerWords, majorWords } from "./words";

/** Each alum and a line about what they do. */
export const STEW_PEOPLE: [string, string][] = [
  ["Dan Tran", "Practicing internist"], ["Alex Lim", "Internal medicine resident"],
  ["Uyen Tran", "Pharmacist, 20+ years"], ["Carolyn Nguyen", "PharmD student"],
  ["David Vo", "Practicing OT"], ["Aileen Dieu", "PT aide, aspiring PA in orthopedics"],
  ["Willy Teav", "Aerospace engineering in defense"], ["David Ho", "Semiconductor engineer"],
  ["Sally Lew", "Nonprofit consulting and education reform"], ["Ryan Barnoya", "Test engineer"],
  ["Ingrid Channa", "Medical student, after gap years"], ["Thanh Lam", "College academic mentor"],
  ["Kenneth Tran", "Admissions consultant"],
];

/** Each alumni table: its field and who hosts it, one alum or a pair. */
export const STEW_TABLES: [string, string][] = [
  ["Internal medicine", "Dan Tran & Alex Lim"], ["Pharmacy", "Uyen Tran & Carolyn Nguyen"], ["OT and PT", "David Vo & Aileen Dieu"],
  ["Aerospace engineering", "Willy Teav"], ["Semiconductor engineering", "David Ho"], ["Nonprofit and education", "Sally Lew"],
  ["Test engineering", "Ryan Barnoya"], ["Medical school", "Ingrid Channa"], ["Academic mentoring", "Thanh Lam"], ["Admissions", "Kenneth Tran"],
];

/** Each fam: table number, name, majors as written on the night, and who sat with them in rounds 1 and 2. */
export const STEW_FAMS: [string, string, string, string, string][] = [
  ["1", "Fam 6", "PoliSci/Comm/Public Affairs", "Kenneth Tran", "Sally Lew"],
  ["2", "Fam 3", "Cog Sci/Math", "Dan Tran & Alex Lim", "Uyen Tran & Carolyn Nguyen"],
  ["3", "Fam 5", "Humanities/Sociology", "Thanh Lam", "Kenneth Tran"],
  ["4", "Fam 2", "Engineering + MCBD", "Willy Teav", "Ingrid Channa"],
  ["5", "Fam 1", "Linguistics/CS/Math", "David Ho", "Ryan Barnoya"],
  ["6", "Fam 4", "Sociology", "Sally Lew", "Thanh Lam"],
  ["7", "Fam 8", "Psych/Data/Math", "Ingrid Channa", "David Vo & Aileen Dieu"],
  ["8", "Fam 7", "Econ/Biz Econ", "Uyen Tran & Carolyn Nguyen", "David Ho"],
  ["9", "Fam 9", "Engineering + Psych", "Ryan Barnoya", "Willy Teav"],
  ["10", "Fam 10", "Bio/Chem/Biochem", "David Vo & Aileen Dieu", "Dan Tran & Alex Lim"],
];

const about = (who: string) => who.split(" & ").map((n) => STEW_PEOPLE.find(([p]) => p === n)?.[1] ?? "").join("; ");

/** Interest words for an alum or pair, from what they do. */
export const stewInterests = (who: string) => careerWords(about(who));

/** The 2026 seating chart as it was kept in a Google Doc: one row per fam, a column per round. */
export function stewChartGrid(): string[][] {
  return [["Fam Table", "Round 1 (alums)", "Round 2 (alums)"],
    ...STEW_FAMS.map(([n, fam, majors, r1, r2]) => [`Table ${n}\n${fam} (${majors})`, r1.replace(" & ", " + "), r2.replace(" & ", " + ")])];
}

/** The STEW 2026 family dinner, with the seating as it happened kept in place. */
export function stewDinner(): EventState {
  const s = newEvent({
    title: "STEW 2026 Family Dinner", rounds: 2,
    // The night as it ran: admits seated from 5:30 PM, round 1 6:16 to 6:28, a 3-minute changeover,
    // round 2 6:31 to 6:43, then open networking (round 3) until closing at 6:58.
    startTime: "5:30 PM", welcomeMinutes: 43, roundMinutes: 12, switchMinutes: 3, openMinutes: 15,
    hosts: STEW_TABLES.map(([table_label, host_name]) => ({ table_label, host_name, tags: stewInterests(host_name).join("; ") })),
    fams: STEW_FAMS.map(([table_number, fam_label, majors]) => ({ table_number, fam_label, interests: majorWords(majors).join("; ") })),
  });
  normalizeState(s);
  const label = (who: string) => STEW_TABLES.find(([, w]) => w === who)![0];
  for (const [, fam, , r1, r2] of STEW_FAMS) { placeInGrid(s, label(r1), fam, 1); placeInGrid(s, label(r2), fam, 2); }
  return s;
}
