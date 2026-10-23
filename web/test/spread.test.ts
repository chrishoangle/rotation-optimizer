import highsLoader from "highs";
import { beforeAll, expect, it } from "vitest";
import { newEvent, normalizeState, solveEvent } from "../src/event";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

const topics = ["Law", "Art", "Data", "Music", "Film", "Policy"];
const waits = (p: ReturnType<typeof solveEvent>) =>
  p.fams.map((f) => [1, 2, 3].filter((r) => !p.assignments.some((a) => a.round === r && a.groupId === f.groupId)).length);

it("a re-plan spreads empty tables over fams before keeping printed slots (as tests/test_uneven.py)", () => {
  const s = newEvent({
    rounds: 3,
    hosts: topics.map((t) => ({ table_label: t, tags: t.toLowerCase() })),
    fams: topics.map((t, i) => ({ fam_label: `Fam ${i + 1}`, interests: t.toLowerCase() })),
    rules: [{ rule: "only in rounds", host_table: "Film", fam: "", rounds: "2, 3" }],
  });
  normalizeState(s);
  s.printed = solveEvent(highs, s, false);
  s.cancelHosts = { h01: 2, h02: 2 };
  expect(Math.max(...waits(solveEvent(highs, s, true)))).toBe(1);
});

it("a step-free host sits out rounds when the room is full (as tests/test_room.py)", () => {
  const s = newEvent({
    rounds: 3,
    hosts: topics.map((t) => ({ table_label: t, tags: t.toLowerCase() })),
    fams: topics.map((t, i) => ({ fam_label: `Fam ${i + 1}`, interests: t.toLowerCase(), step_free: i === 0 ? "yes" : "" })),
    rules: [{ rule: "needs step-free", host_table: "Law", fam: "", rounds: "" }],
  });
  normalizeState(s);
  const p = solveEvent(highs, s, false);
  expect(p.assignments.filter((a) => a.hostId === "h01").map((a) => a.groupId)).toEqual(["fam_01"]);
});
