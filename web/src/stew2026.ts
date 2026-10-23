// The example dinner: the STEW 2026 family dinner as it really ran, used by
// "Try an example" and the walkthrough. Real alumni, included at the
// maintainer's decision: names and what each does only. No contact details,
// employers, or schools.

import type { EventState } from "./event";
import { newEvent, normalizeState } from "./event";
import { placeInGrid } from "./people";
import { careerWords, majorWords } from "./words";

/** Each alumni table: its field, who hosts it (one alum or a pair), and what they do. */
const TABLES: [string, string, string][] = [
  ["Internal medicine", "Dan Tran & Alex Lim", "Practicing internist; internal medicine resident"],
  ["Pharmacy", "Uyen Tran & Carolyn Nguyen", "Pharmacist; PharmD student"],
  ["OT and PT", "David Vo & Aileen Dieu", "Practicing OT; PT aide, aspiring PA in orthopedics"],
  ["Aerospace engineering", "Willy Teav", "Aerospace engineering in defense"],
  ["Semiconductor engineering", "David Ho", "Semiconductor engineer"],
  ["Nonprofit and education", "Sally Lew", "Nonprofit consulting and education reform"],
  ["Test engineering", "Ryan Barnoya", "Test engineer"],
  ["Medical school", "Ingrid Channa", "Medical student, after gap years"],
  ["Academic mentoring", "Thanh Lam", "College academic mentor"],
  ["Admissions", "Kenneth Tran", "Admissions consultant"],
];

/** Each fam: table number, name, majors as written on the night, and who sat with them in rounds 1 and 2. */
const FAMS: [string, string, string, string, string][] = [
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

/** The STEW 2026 family dinner, with the seating as it happened kept in place. */
export function stewDinner(): EventState {
  const s = newEvent({
    title: "STEW 2026 Family Dinner", rounds: 2,
    hosts: TABLES.map(([table_label, host_name, about]) => ({ table_label, host_name, tags: careerWords(about).join("; ") })),
    fams: FAMS.map(([table_number, fam_label, majors]) => ({ table_number, fam_label, interests: majorWords(majors).join("; ") })),
  });
  normalizeState(s);
  const label = (who: string) => TABLES.find(([, w]) => w === who)![0];
  for (const [, fam, , r1, r2] of FAMS) { placeInGrid(s, label(r1), fam, 1); placeInGrid(s, label(r2), fam, 2); }
  return s;
}
