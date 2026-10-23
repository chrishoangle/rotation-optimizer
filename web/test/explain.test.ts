import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { explainPairing, sharedPairings } from "../src/explain";
import { makeGroup, makeHost } from "../src/models";
import { planEvent } from "../src/planning";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

describe("explaining a pairing", () => {
  const hosts = [
    makeHost("h1", "Medicine", "Medicine", ["medicine", "biology"], "Alum A"),
    makeHost("h2", "Law", "Law", ["law", "policy"], "Alum B"),
    makeHost("h3", "Tech", "Tech", ["software", "data"]),
  ];
  const fams = [
    makeGroup("f1", "Fam Red", ["biology", "linguistics"], { tableNumber: 1 }),
    makeGroup("f2", "Fam Blue", ["law"], { tableNumber: 2 }),
    makeGroup("f3", "Fam Gold", ["data", "biology"], { tableNumber: 3 }),
  ];

  it("names the shared interests, the unmatched ones, and every host to choose from", () => {
    const p = planEvent(highs, hosts, fams, 2);
    const r = p.assignments.find((a) => a.groupId === "f1" && a.hostId === "h1")!.round;
    const x = explainPairing(p, r, "f1");
    expect(x.lines[0]).toBe("Medicine and Fam Red both list biology, so the pairing scores 33.");
    expect(x.lines).toContain("No host lists linguistics, so those interests cannot add to any score.");
    expect(x.options.map((o) => o.hostId)).toEqual(["h1", "h2", "h3"]);
    expect(x.options[0]).toMatchObject({ label: "Alum A (Medicine)", current: true, where: "here now" });
  });

  it("points to the best match when the fam did not get it this round", () => {
    const p = planEvent(highs, hosts, fams, 2);
    const r = p.assignments.find((a) => a.groupId === "f1" && a.hostId !== "h1")!.round;
    const lines = explainPairing(p, r, "f1").lines;
    expect(lines.some((l) => /^The best match for Fam Red is Medicine \(score 33\), which meets them in round [12]\.$/.test(l))).toBe(true);
  });

  it("counts pairings that share an interest, with open tables as not sharing", () => {
    const p = planEvent(highs, hosts.slice(0, 2), fams, 2);
    const [shared, all] = sharedPairings(p);
    expect(all).toBe(6);
    expect(shared).toBe(p.assignments.filter((a) => a.score > 0).length);
  });
});
