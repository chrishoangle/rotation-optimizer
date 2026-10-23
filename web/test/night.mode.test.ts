import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { isCurrent, newEvent, normalizeState, solveEvent } from "../src/event";
import { movesBetween } from "../src/moves";
import { addLateHost, cancelHost, currentRound, finishRound, joinLate, moveFamTable, notArrived, setupMissing, toggleSetup, whereIs } from "../src/night";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

function dinner() {
  const s = newEvent({
    title: "Dinner", rounds: 3,
    hosts: ["Law", "Art", "Data", "Music"].map((t, i) => ({ table_label: t, host_name: `Alum ${"ABCD"[i]}`, tags: t.toLowerCase() })),
    fams: ["Red", "Blue", "Gold", "Teal"].map((n, i) => ({ fam_label: `Fam ${n}`, interests: ["law", "art", "data", "music"][i], students: `Student 0${i + 1}` })),
  });
  normalizeState(s);
  solveEvent(highs, s, false);
  s.printed = s.plan;
  return s;
}

describe("night mode actions", () => {
  it("finishes rounds but never the last one, and logs each", () => {
    const s = dinner();
    expect(currentRound(s)).toBe(1);
    finishRound(s, "7:00 PM"); finishRound(s, "7:20 PM"); finishRound(s, "7:40 PM");
    expect(s.finished).toBe(2);
    expect(currentRound(s)).toBe(3);
    expect(s.nightLog.map((e) => e.text)).toEqual(["Round 1 finished.", "Round 2 finished."]);
  });

  it("finds alumni, fams, and students by part of a name", () => {
    const s = dinner();
    const [alum] = whereIs(s.plan!, "alum b", 2);
    expect(alum.title).toBe("Alum B (Art)");
    expect(alum.lines.map((l) => l.slice(0, 8))).toEqual(["Round 2:", "Round 3:"]);
    const [student] = whereIs(s.plan!, "student 03", 1);
    expect(student).toEqual({ kind: "student", title: "Student 03", lines: [expect.stringMatching(/^Table \d \(Fam Gold\) all night$/)] });
    expect(whereIs(s.plan!, "x", 1)).toEqual([]);
  });

  it("adds a late alum from a later round without touching finished rounds", () => {
    const s = dinner();
    finishRound(s, "7:00 PM");
    expect(addLateHost(s, { table: "Law", person: "", tags: "", from: 2 }, "7:05 PM")).toMatch(/already a host table named Law/);
    expect(addLateHost(s, { table: "Film", person: "Alum E", tags: "art; music", from: 1 }, "7:05 PM")).toBe("Choose a round from 2 to 3.");
    cancelHost(s, "h04", 2, "7:04 PM"); // Music leaves, so a fam needs a host
    expect(addLateHost(s, { table: "Film", person: "Alum E", tags: "art; music", from: 2 }, "7:05 PM")).toBe("");
    expect(s.rules.at(-1)).toEqual({ rule: "only in rounds", host_table: "Film", fam: "", rounds: "2, 3" });
    expect(isCurrent(s)).toBe(false);
    const round1 = s.plan!.assignments.filter((a) => a.round === 1);
    solveEvent(highs, s, true);
    expect(s.plan!.assignments.filter((a) => a.round === 1)).toEqual(round1);
    expect(s.plan!.assignments.some((a) => a.hostId === "h05" && a.round >= 2)).toBe(true);
    expect(s.arrived).toContain("h05");
    expect(s.nightLog.at(-1)!.text).toBe("Added Alum E (Film) as a host from round 2.");
  });

  it("says when a late alum gets no table because every fam keeps its printed host", () => {
    const s = dinner();
    finishRound(s, "7:00 PM");
    addLateHost(s, { table: "Film", person: "Alum E", tags: "film", from: 2 }, "7:05 PM");
    solveEvent(highs, s, true);
    const m = movesBetween(s.printed!, s.plan!, 2);
    expect(m.hosts.filter((x) => x.hostId === "h05").map((x) => x.text)).toEqual([
      "Alum E (Film): every fam already has a host, so no table for now. Seat them with a host table that shares their interests.",
    ]);
  });

  it("a no-show is a cancellation from the current round, and leaves check-in", () => {
    const s = dinner();
    s.arrived = ["h01", "h02"];
    expect(notArrived(s).map((x) => x.id)).toEqual(["h03", "h04"]);
    cancelHost(s, "h03", 1, "6:45 PM", true);
    expect(s.cancelHosts).toEqual({ h03: 1 });
    expect(notArrived(s).map((x) => x.id)).toEqual(["h04"]);
    expect(s.nightLog.at(-1)!.text).toBe("Alum C (Data) did not show up, cancelled from round 1.");
    solveEvent(highs, s, true);
    expect(s.plan!.assignments.some((a) => a.hostId === "h03")).toBe(false);
  });

  it("a fam sitting at another table swaps numbers, and the alumni are told", () => {
    const s = dinner();
    const tables = s.plan!.fams.map((f) => [f.groupId, f.tableNumber]);
    expect(moveFamTable(s, "fam_01", 0, "6:10 PM")).toMatch(/^Type the number/);
    expect(moveFamTable(s, "fam_01", 3, "6:10 PM")).toBe("");
    expect(s.fams.find((r) => r.fam_id === "fam_01")!.table_number).toBe("3");
    expect(s.fams.find((r) => r.fam_id === "fam_03")!.table_number).toBe("1");
    expect(s.nightLog.at(-1)!.text).toBe("Fam Red is at Table 3, not 1; Fam Gold moves to Table 1.");
    solveEvent(highs, s, true);
    expect(s.plan!.keptSlots).toBe(12); // nobody's pairing changed
    const m = movesBetween(s.printed!, s.plan!, 1);
    const red = m.hosts.filter((x) => x.text.includes("Fam Red is at Table 3, not Table 1 as your card says."));
    expect(red.length).toBe(3);
    void tables;
  });

  it("setup counts tables until each is checked", () => {
    const s = dinner();
    expect(setupMissing(s)).toHaveLength(4);
    toggleSetup(s, "fam_02");
    expect(setupMissing(s)).toEqual(["Table 1 (Fam Red)", "Table 3 (Fam Gold)", "Table 4 (Fam Teal)"]);
    toggleSetup(s, "fam_02");
    expect(setupMissing(s)).toHaveLength(4);
  });

  it("an alum who didn't show can join from a later round", () => {
    const s = dinner();
    cancelHost(s, "h02", 1, "6:30 PM", true);
    solveEvent(highs, s, true);
    finishRound(s, "6:50 PM");
    expect(joinLate(s, "h02", 1, "6:55 PM")).toBe("Choose a round from 2 to 3.");
    expect(joinLate(s, "h02", 2, "6:55 PM")).toBe("");
    expect(s.cancelHosts).toEqual({});
    expect(s.rules.at(-1)).toEqual({ rule: "only in rounds", host_table: "Art", fam: "", rounds: "2, 3" });
    const round1 = s.plan!.assignments.filter((a) => a.round === 1);
    solveEvent(highs, s, true);
    expect(s.plan!.assignments.filter((a) => a.round === 1)).toEqual(round1);
    expect(s.plan!.assignments.filter((a) => a.hostId === "h02").map((a) => a.round)).toEqual([2, 3]);
    expect(s.nightLog.at(-1)!.text).toBe("Alum B (Art) arrived late and hosts from round 2.");
  });

  it("where a table is stays with the table when a fam moves", () => {
    const s = dinner();
    s.fams[0].location = "balcony"; s.fams[0].step_free = "";
    s.fams[2].location = "near the door"; s.fams[2].step_free = "yes";
    expect(moveFamTable(s, "fam_01", 3, "6:10 PM")).toBe("");
    expect([s.fams[0].location, s.fams[0].step_free]).toEqual(["near the door", "yes"]);
    expect([s.fams[2].location, s.fams[2].step_free]).toEqual(["balcony", ""]);
    expect(moveFamTable(s, "fam_02", 9, "6:12 PM")).toBe("");
    expect([s.fams[1].table_number, s.fams[1].location]).toEqual(["9", ""]);
  });
});
