import { describe, expect, it } from "vitest";
import { checkInputs, newEvent, normalizeState } from "../src/event";
import { clearGrid, gridChanges, hostSettings, placeInGrid, renameInRules, setHostSettings, settingsWords } from "../src/people";

function event() {
  const s = newEvent({
    rounds: 3,
    hosts: [{ table_label: "Law", host_name: "Alum A", tags: "law" }, { table_label: "Art", host_name: "Alum B", tags: "art" }, { table_label: "Data", tags: "data" }],
    fams: [{ fam_label: "Fam Red", interests: "law" }, { fam_label: "Fam Blue", interests: "art" }, { fam_label: "Fam Gold", interests: "data" }],
  });
  normalizeState(s);
  return s;
}

describe("alum settings instead of rules", () => {
  it("round trip through ordinary rules the planner reads", () => {
    const s = event();
    setHostSettings(s, "h01", { from: 2, until: 3, stays: false, stepFree: true, must: ["Fam Red"], never: ["Fam Blue"] });
    expect(s.rules.map((r) => r.rule)).toEqual(["only in rounds", "needs step-free", "must meet", "never meet"]);
    expect(hostSettings(s, "h01")).toEqual({ from: 2, until: 3, stays: false, stepFree: true, must: ["Fam Red"], never: ["Fam Blue"] });
    expect(settingsWords(s, "h01")).toEqual(["arrives for round 2", "step-free tables only", "must meet Fam Red", "never meets Fam Blue"]);
    expect(checkInputs(s).problems).toEqual([]);
    setHostSettings(s, "h01", { from: 1, until: 3, stays: false, stepFree: false, must: [], never: [] });
    expect(s.rules).toEqual([]);
  });

  it("renaming an alum or a fam keeps their settings", () => {
    const s = event();
    setHostSettings(s, "h01", { ...hostSettings(s, "h01"), must: ["Fam Red"] });
    s.hosts[0].table_label = "Law and Policy";
    renameInRules(s, "host", "Law", "Law and Policy");
    s.fams[0].fam_label = "Fam Crimson";
    renameInRules(s, "fam", "Fam Red", "Fam Crimson");
    expect(settingsWords(s, "h01")).toEqual(["must meet Fam Crimson"]);
  });

  it("moves in the grid are kept apart from settings, replaced per round, and undone together", () => {
    const s = event();
    setHostSettings(s, "h01", { ...hostSettings(s, "h01"), never: ["Fam Blue"] });
    placeInGrid(s, "Law", "Fam Red", 2);
    placeInGrid(s, "Art", "Fam Red", 2); // replaces the move to Fam Red in round 2
    expect(gridChanges(s)).toEqual([{ rule: "must meet", host_table: "Art", fam: "Fam Red", rounds: "2", by: "grid" }]);
    expect(hostSettings(s, "h01").never).toEqual(["Fam Blue"]);
    clearGrid(s);
    expect(gridChanges(s)).toEqual([]);
    expect(s.rules).toHaveLength(1);
  });
});
