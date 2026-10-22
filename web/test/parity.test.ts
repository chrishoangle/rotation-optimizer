// The web app must give the same answers as the Python package. The
// fixture is written by scripts/export_parity_cases.py from Python.

import { readFileSync } from "node:fs";
import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { beforeTheNight, checkInputs, fingerprint, loadEvent, nearMisses, solveEvent } from "../src/event";
import {
  hostCardsHtml, hostViewRows, runSheetHtml, scheduleCsv, seatingChartHtml, tableTentsHtml,
} from "../src/export";
import { makeGroup } from "../src/models";
import { describeReprint, fairnessWarnings, openSlots, planChanges, provenOptimal, reprintList, slotText, zeroSlots } from "../src/planning";
import { InfeasibleProblemError } from "../src/planning";
import { SheetError, columnReport, groupStudentRows, matchColumns, parseRounds } from "../src/sheets";
import type { HighsLike } from "../src/solver";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));
let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

describe("scheduling matches Python", () => {
  for (const c of fixture.solve) {
    it(c.name, () => {
      const s = loadEvent(JSON.stringify(c.event));
      const expect_ = c.expect;
      let got: Record<string, unknown>;
      try {
        const plan = solveEvent(highs, s, c.keep_printed);
        got = {
          total: plan.totalScore, proven: provenOptimal(plan), kept: plan.keptSlots,
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
