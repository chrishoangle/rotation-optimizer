// Re-planning on the night, the same checks as tests/test_night.py.

import { readFileSync } from "node:fs";
import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { EventState, newEvent, normalizeState, solveEvent } from "../src/event";
import { slots } from "../src/planning";
import { csvRecords } from "../src/py";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

function example(rounds: number): EventState {
  const read = (name: string) => csvRecords(readFileSync(new URL(`../../templates/${name}`, import.meta.url), "utf8")).rows;
  const s = newEvent({ hosts: read("practice_hosts.csv"), fams: read("practice_fams.csv"), rounds });
  normalizeState(s);
  return s;
}

describe("any single cancellation after round 1 can be re-planned", () => {
  for (const rounds of [3, 4, 5]) {
    it(`${rounds} rounds`, () => {
      const base = example(rounds);
      solveEvent(highs, base);
      base.printed = base.plan;
      const failures: string[] = [];
      for (const [kind, ids] of [["host", base.hosts.map((r) => r.host_id)], ["fam", base.fams.map((r) => r.fam_id)]] as const) {
        for (const id of ids) {
          const s = structuredClone(base);
          s.finished = 1;
          (kind === "host" ? s.cancelHosts : s.cancelFams)[id] = 2;
          try {
            const plan = solveEvent(highs, s);
            const first = [...slots(plan)].filter((k) => k.startsWith("1\u0000")).sort();
            expect(first).toEqual([...slots(base.printed!)].filter((k) => k.startsWith("1\u0000")).sort());
          } catch (err) {
            failures.push(`${kind} ${id}: ${(err as Error).message}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
