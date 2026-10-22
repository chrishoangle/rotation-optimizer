// The web app must give the same answers as the Python package. The
// fixture is written by scripts/export_parity_cases.py from Python.

import { readFileSync } from "node:fs";
import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { beforeTheNight, checkInputs, fingerprint, handoffEvent, loadEvent, nearMisses, saveEvent, solveEvent } from "../src/event";
import {
  hostCardsHtml, hostViewRows, runSheetHtml, scheduleCsv, seatingChartHtml, tableTentsHtml,
} from "../src/export";
import { makeGroup, makeHost } from "../src/models";
import { EventPlan, describeReprint, fairnessWarnings, hostWarnings, openSlots, planChanges, provenOptimal, reprintList, slotText, zeroSlots } from "../src/planning";
import { InfeasibleProblemError } from "../src/planning";
import { SheetError, columnReport, groupStudentRows, matchColumns, parseRounds } from "../src/sheets";
import type { HighsLike } from "../src/solver";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));
let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

/** The even-spread penalty the planner minimizes, measured as in export_parity_cases.py. */
function spreadPenalty(p: EventPlan): number {
  const every = Array.from({ length: p.rounds }, (_, k) => k + 1);
  const sides: [Set<number>, Set<number>][] = [
    ...p.hosts.map((h): [Set<number>, Set<number>] => [new Set([...(p.hostAway[h.hostId] ?? []), ...(p.hostLimits[h.hostId] ?? [])]),
      new Set(p.assignments.filter((a) => a.hostId === h.hostId).map((a) => a.round))]),
    ...p.fams.map((f): [Set<number>, Set<number>] => [new Set(p.famAway[f.groupId] ?? []),
      new Set(p.assignments.filter((a) => a.groupId === f.groupId).map((a) => a.round))]),
  ];
  let total = 0;
  for (const [away, met] of sides) {
    const avail = every.filter((r) => !away.has(r));
    const empty = avail.filter((r) => !met.has(r)).length;
    for (let k = 1; k < avail.length; k++) total += Math.max(0, empty - k);
  }
  return total;
}

describe("scheduling matches Python", () => {
  for (const c of fixture.solve) {
    it(c.name, () => {
      const s = loadEvent(JSON.stringify(c.event));
      const expect_ = c.expect;
      let got: Record<string, unknown>;
      try {
        const plan = solveEvent(highs, s, c.keep_printed);
        got = {
          total: plan.totalScore, proven: provenOptimal(plan), kept: plan.keptSlots, spread_penalty: spreadPenalty(plan),
          weak: zeroSlots(plan).length + openSlots(plan).length,
          warnings_no_fairness: plan.warnings.filter((w) => !w.startsWith("Fairness")),
        };
      } catch (err) {
        if (err instanceof SheetError) got = { problems: err.problems };
        else if (err instanceof InfeasibleProblemError) got = { error: err.message };
        else throw err;
      }
      if ("total" in expect_) {
        // Equal-score schedules can differ in which pairs score 0, so the weak count is not compared.
        expect({ ...got, weak: undefined }).toEqual({ ...expect_, weak: undefined });
      } else {
        expect(got).toEqual(expect_);
      }
    });
  }
});

describe("messages and helpers match Python", () => {
  const m = fixture.messages;
  it("check inputs", () => {
    for (const c of m.check_inputs) {
      const inp = checkInputs(loadEvent(JSON.stringify(c.event)));
      expect(inp.problems).toEqual(c.problems);
      expect(inp.warnings).toEqual(c.warnings);
    }
  });
  it("fingerprints", () => {
    for (const c of m.fingerprint) expect(fingerprint(loadEvent(JSON.stringify(c.event)))).toBe(c.fingerprint);
  });
  it("parse rounds", () => {
    for (const c of m.parse_rounds) {
      if ("error" in c) expect(() => parseRounds(c.text, c.rounds)).toThrow(c.error);
      else expect(parseRounds(c.text, c.rounds)).toEqual(c.value);
    }
  });
  it("near misses", () => {
    for (const c of m.near_misses) expect(nearMisses(c.hosts, c.fams).map((x) => [x.spellings, x.suggestion])).toEqual(c.out);
  });
  it("column matching", () => {
    for (const c of m.match_columns) expect(matchColumns(c.columns, c.kind)).toEqual(c.mapping);
    for (const c of m.column_report) {
      const [problems, notices, mapping] = columnReport(c.columns, c.kind);
      expect([problems, notices, mapping]).toEqual([c.problems, c.notices, c.mapping]);
    }
  });
  it("grouping one row per student", () => {
    for (const c of m.group_student_rows) expect(groupStudentRows(c.rows)).toEqual([c.out, c.count]);
  });
  it("fairness", () => {
    for (const c of m.fairness) {
      const fams = c.fams.map(([id, name]: [string, string]) => makeGroup(id, name, ["x"]));
      const real = c.real.map(([r, h, g, s]: [number, string, string, number]) => ({ round: r, hostId: h, groupId: g, score: s }));
      expect(fairnessWarnings(fams, real, c.rounds, {}, { h1: "Pharmacy" })).toEqual(c.out);
    }
  });
  it("host tables without a fam", () => {
    for (const c of m.host_warnings) {
      const hosts = c.hosts.map(([id, name]: [string, string]) => makeHost(id, name, name, ["x"]));
      const real = c.real.map(([r, h, g, sc]: [number, string, string, number]) => ({ round: r, hostId: h, groupId: g, score: sc }));
      expect(hostWarnings(hosts, real, c.rounds, c.host_away)).toEqual(c.out);
    }
  });
  it("event file keeps check-in, notes, and the night's log", () => {
    for (const c of m.event_file) {
      const s = loadEvent(c.text);
      expect([s.arrived, s.notes, s.nightLog]).toEqual([c.arrived, c.notes, c.night_log]);
      const again = loadEvent(saveEvent(s));
      expect([again.arrived, again.notes, again.nightLog]).toEqual([c.arrived, c.notes, c.night_log]);
      const hand = handoffEvent(s);
      expect({ arrived: hand.arrived, notes: hand.notes, night_log: hand.nightLog }).toEqual(c.handoff);
    }
  });
  it("before the night", () => {
    for (const c of m.before_the_night) {
      expect(beforeTheNight(loadEvent(JSON.stringify(c.event)), c.saved).map((i) => [i.status, i.text])).toEqual(c.items);
    }
  });
});

describe("printouts match Python byte for byte", () => {
  for (const c of fixture.printouts) {
    it(c.name, () => {
      const s = loadEvent(JSON.stringify(c.event));
      const p = s.plan!;
      expect(seatingChartHtml(p, "Example dinner")).toBe(c.seating_chart);
      expect(seatingChartHtml(p, "Example dinner", [2], false, "7:42 PM")).toBe(c.seating_chart_round_2);
      expect(hostCardsHtml(p, null, "Example dinner")).toBe(c.host_cards);
      expect(tableTentsHtml(p)).toBe(c.table_tents);
      expect(runSheetHtml(p, "Example dinner", "6:30 PM", 20)).toBe(c.run_sheet);
      expect(runSheetHtml(p, "Example dinner")).toBe(c.run_sheet_blank);
      expect(scheduleCsv(p)).toBe(c.schedule_csv);
      expect(hostViewRows(p)).toEqual(c.host_view);
      if (c.reprint) {
        const printed = loadEvent(JSON.stringify(c.event)).printed!;
        expect(describeReprint(reprintList(printed, p), p)).toEqual(c.reprint);
        expect(planChanges(printed, p).map((x) => [x.round, x.famId, slotText(printed, x.round, x.famId), slotText(p, x.round, x.famId)])).toEqual(c.changes);
      }
    });
  }
});
