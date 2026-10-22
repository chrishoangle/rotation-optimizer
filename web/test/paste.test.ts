import { describe, expect, it } from "vitest";
import { parsePasted } from "../src/paste";

describe("pasting from a spreadsheet", () => {
  it("leaves a single value to the browser", () => {
    expect(parsePasted("Medicine")).toBeNull();
    expect(parsePasted("Medicine\n")).toBeNull();
  });
  it("splits rows and columns from Google Sheets or Excel", () => {
    expect(parsePasted("Medicine\tAlum A\tmedicine; biology\r\nLaw\tAlum B\tlaw\r\n")).toEqual([
      ["Medicine", "Alum A", "medicine; biology"],
      ["Law", "Alum B", "law"],
    ]);
  });
  it("keeps empty cells in place and drops empty rows", () => {
    expect(parsePasted("Medicine\t\tbiology\n\t\t\nLaw\tAlum B\t")).toEqual([
      ["Medicine", "", "biology"],
      ["Law", "Alum B", ""],
    ]);
  });
  it("reads quoted cells with line breaks, tabs, and quotes", () => {
    expect(parsePasted('Fam Red\t"Student 1\nStudent 2"\nFam "Blue"\t"say ""hi""\tthere"')).toEqual([
      ["Fam Red", "Student 1 Student 2"],
      ['Fam "Blue"', 'say "hi"\tthere'],
    ]);
  });
  it("pastes one column of names as rows", () => {
    expect(parsePasted("Red\nBlue\nGold")).toEqual([["Red"], ["Blue"], ["Gold"]]);
  });
});
