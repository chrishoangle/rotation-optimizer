import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { newEvent, normalizeState, solveEvent } from "../src/event";
import { tableNumbers } from "../src/export";
import { changeSlipsHtml, movesBetween } from "../src/moves";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

const TAGS = ["law", "art", "data", "music", "film", "policy"];
function dinner(hostCount: number, famCount: number, rounds: number) {
  const s = newEvent({
    rounds,
    hosts: Array.from({ length: hostCount }, (_, i) => ({ table_label: `Host ${i + 1}`, host_name: `Alum ${String.fromCharCode(65 + i)}`, tags: `${TAGS[i % 6]}; ${TAGS[(i + 2) % 6]}` })),
    fams: Array.from({ length: famCount }, (_, i) => ({ fam_label: `Fam ${i + 1}`, interests: `${TAGS[(i + 1) % 6]}; ${TAGS[(i + 3) % 6]}` })),
  });
  normalizeState(s);
  solveEvent(highs, s, false);
  s.printed = s.plan;
  return s;
}

describe("what to tell people after a re-plan", () => {
  it("says nothing when nothing changed", () => {
    const s = dinner(5, 5, 3);
    expect(movesBetween(s.printed!, s.plan!, 1)).toEqual({ hosts: [], fams: [], mc: [] });
  });

  it("tells moved alumni where to go and warns fams left without a host", () => {
    const s = dinner(5, 5, 3);
    s.finished = 1;
    s.cancelHosts = { h02: 2 };
    solveEvent(highs, s, true);
    const m = movesBetween(s.printed!, s.plan!, 2);
    // The cancelled alum is not in the room, so nobody is told about them.
    expect(m.hosts.every((x) => x.hostId !== "h02")).toBe(true);
    // 4 hosts for 5 fams: one fam has no host in each remaining round.
    expect(m.fams.length).toBeGreaterThan(0);
    expect(m.fams[0].text).toMatch(/^Table \d+ \(Fam \d\) has no host in round [23]\./);
    for (const x of m.hosts) expect(x.text).toMatch(/^Alum [A-E] \(Host \d\): in round [23], go to Table \d+ \(Fam \d\) instead of Table \d+ \(Fam \d\)\.$/);
    expect(m.mc.every((l) => l.startsWith("Before round "))).toBe(true);
  });

  it("says the table is the same when only the fam sitting there changed", () => {
    const s = dinner(5, 5, 3);
    const before = s.printed!;
    const after = structuredClone(before);
    // Two fams trade tables, and in round 2 their hosts trade fams, so each host stays at the same table.
    const [f1, f2] = after.fams;
    const t = tableNumbers(before);
    [f1.tableNumber, f2.tableNumber] = [t[f2.groupId], t[f1.groupId]];
    for (const a of after.assignments) {
      if (a.round !== 2) continue;
      if (a.groupId === f1.groupId) a.groupId = f2.groupId;
      else if (a.groupId === f2.groupId) a.groupId = f1.groupId;
    }
    const lines = movesBetween(before, after, 2).hosts.filter((x) => x.round === 2).map((x) => x.text);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l).toMatch(/: in round 2, still Table (\d+)\. Fam \d is sitting there now, not Fam \d as your card says\.$/);
  });

  it("introduces a host added late", () => {
    const s = dinner(4, 5, 3);
    s.finished = 1;
    s.hosts.push({ host_id: "h05", table_label: "Late Host", host_name: "Alum Z", tags: "law; art" });
    s.rules.push({ rule: "only in rounds", host_table: "Late Host", fam: "", rounds: "2, 3" });
    solveEvent(highs, s, true);
    const m = movesBetween(s.printed!, s.plan!, 2);
    const late = m.hosts.filter((x) => x.hostId === "h05");
    expect(late.map((x) => x.round)).toEqual([2, 3]);
    expect(late[0].text).toMatch(/^Alum Z \(Late Host\): new host\. In round 2, go to Table \d+/);
    const page = changeSlipsHtml(s.plan!, late, "Dinner", "7:42 PM");
    expect(page).toContain("Change at 7:42 PM");
    expect(page).toContain("Your card said: New host");
  });
});
