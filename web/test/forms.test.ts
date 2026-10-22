import { describe, expect, it } from "vitest";
import { FIELDS, HOST_QUESTIONS, STUDENT_QUESTIONS, formsScript } from "../src/forms";
import { columnReport, groupStudentRows, matchColumns, renameColumns } from "../src/sheets";

describe("sign-up forms", () => {
  it("their CSV exports are recognized with no column matching", () => {
    const hosts = ["Timestamp", HOST_QUESTIONS.name, HOST_QUESTIONS.table, HOST_QUESTIONS.fields];
    expect(matchColumns(hosts, "hosts")).toEqual({ host_name: HOST_QUESTIONS.name, table_label: HOST_QUESTIONS.table, tags: HOST_QUESTIONS.fields });
    const students = ["Timestamp", STUDENT_QUESTIONS.name, STUDENT_QUESTIONS.fam, STUDENT_QUESTIONS.fields];
    expect(matchColumns(students, "fams")).toEqual({ students: STUDENT_QUESTIONS.name, fam_label: STUDENT_QUESTIONS.fam, interests: STUDENT_QUESTIONS.fields });
    expect(columnReport(students, "fams")[0]).toEqual([]);
  });

  it("checkbox answers become shared tags, grouped by fam", () => {
    const rows = renameColumns([
      { Timestamp: "1", [STUDENT_QUESTIONS.name]: "Student 01", [STUDENT_QUESTIONS.fam]: "Fam Red", [STUDENT_QUESTIONS.fields]: "Biology, Pre-med" },
      { Timestamp: "2", [STUDENT_QUESTIONS.name]: "Student 02", [STUDENT_QUESTIONS.fam]: "Fam Red", [STUDENT_QUESTIONS.fields]: "Chemistry" },
    ], matchColumns(["Timestamp", ...Object.values(STUDENT_QUESTIONS)], "fams"));
    const [fams, n] = groupStudentRows(rows);
    expect(n).toBe(2);
    expect(fams[0].fam_label).toBe("Fam Red");
    expect(fams[0].interests.toLowerCase()).toContain("pre-med");
  });

  it("the script lists every field and never asks for an email", () => {
    const script = formsScript("Transfer Dinner");
    for (const f of FIELDS) expect(script).toContain(JSON.stringify(f));
    expect(script).toContain("setCollectEmail(false)");
    expect(script).toContain('"Transfer Dinner: alumni host sign-up"');
    expect(FIELDS.length).toBeGreaterThan(30);
  });
});
