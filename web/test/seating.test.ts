import { describe, expect, it } from "vitest";
import { pairKey, readAlumniList, readFamCell, readSeatingChart } from "../src/seating";
import { careerWords, majorWords } from "../src/words";

// Invented people only: coordinators' real lists never go in the repository.
const CHART = [
  ["Fam Table", "Round 1 (alums)", "Round 2 (alums)"],
  ["Table 1\nFam 6 (PoliSci/Comm/Public Affairs)", "Ann Park", "Bo Lin"],
  ["Table 2\nFam 3 (Cog Sci/Math)", "Cy Ruiz + Di Wu", "Ed Fox + Flo Gale"],
  ["Table 3\nFam 4 (Sociology × 4)", "Bo Lin", "Ann Park"],
  ["Table 4\nFam 10 (Bio/Chem/Biochem)", "Ed Fox + Flo Gale", "Di Wu & Cy Ruiz"],
];

describe("reading a seating chart as coordinators keep it", () => {
  it("reads fams, majors in plain words, pairs, and who sat where", () => {
    const c = readSeatingChart(CHART)!;
    expect(c.rounds).toBe(2);
    expect(c.fams.map((f) => [f.table, f.name])).toEqual([["1", "Fam 6"], ["2", "Fam 3"], ["3", "Fam 4"], ["4", "Fam 10"]]);
    expect(c.fams[0].interests).toEqual(["political science", "communications", "public affairs"]);
    expect(c.fams[2].interests).toEqual(["sociology"]);
    expect(c.fams[3].interests).toEqual(["biology", "chemistry", "biochemistry"]);
    // A pair written either way round is one table.
    expect(c.hosts).toEqual(["Ann Park", "Bo Lin", "Cy Ruiz & Di Wu", "Ed Fox & Flo Gale"]);
    expect(c.seats).toContainEqual({ fam: "Fam 10", round: 2, host: "Cy Ruiz & Di Wu" });
    expect(c.seats).toHaveLength(8);
  });

  it("leaves ordinary lists alone", () => {
    expect(readSeatingChart([["Name", "Interests"], ["Ann Park", "law"]])).toBeNull();
  });

  it("reads a fam cell written on one line", () => {
    expect(readFamCell("Table 7 Fam 8 (Psych/Data/Math)", 7)).toEqual({ table: "7", name: "Fam 8", interests: ["psychology", "data", "math"] });
    expect(readFamCell("Fam Gold - Bio, Chem", 2)).toEqual({ table: "2", name: "Fam Gold", interests: ["biology", "chemistry"] });
  });

  it("matches pairs however they are written", () => {
    expect(pairKey("Ann Park + Bo Lin")).toBe(pairKey("bo lin & ann park"));
  });
});

describe("reading an alumni list with emails", () => {
  const LIST = "Ann Park: ann@example.com\nPracticing internist\nBo Lin: bo@example.org\nTest engineer at a connector maker\nCy Ruiz, cy@example.com\nDatabase analyst at a hospital";
  it("keeps names and what they do, drops emails, and reads interests", () => {
    const list = readAlumniList(LIST)!;
    expect(list.map((a) => a.name)).toEqual(["Ann Park", "Bo Lin", "Cy Ruiz"]);
    expect(JSON.stringify(list)).not.toContain("@");
    expect(list[0].interests).toContain("medicine");
    expect(list[1].interests).toContain("engineering");
    expect(list[2].interests).toContain("data");
  });
  it("leaves spreadsheet rows and plain lists to the ordinary reader", () => {
    expect(readAlumniList("Ann Park\tann@example.com\tlaw\nBo Lin\tbo@example.com\tmedicine")).toBeNull();
    expect(readAlumniList("Ann Park, law; policy\nBo Lin, medicine")).toBeNull();
  });
});

describe("plain words that match", () => {
  it("expands major shorthand", () => {
    expect(majorWords("Engineering + MCBD")).toEqual(["engineering", "biology"]);
    expect(majorWords("Econ/Biz Econ")).toEqual(["economics", "business"]);
    expect(majorWords("Linguistics/CS/Math")).toEqual(["linguistics", "computer science", "math"]);
  });
  it("reads careers as the same words", () => {
    expect(careerWords("Aerospace engineering in defense")).toEqual(expect.arrayContaining(["engineering"]));
    expect(careerWords("Current PharmD student")).toContain("pharmacy");
    expect(careerWords("Nonprofit consulting and education reform")).toEqual(expect.arrayContaining(["education", "public affairs"]));
    expect(careerWords("Dog walker")).toEqual([]);
  });
});
