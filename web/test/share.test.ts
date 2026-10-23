import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { makeGroup, makeHost } from "../src/models";
import { planEvent } from "../src/planning";
import { hostBadgesHtml, runnerGroups, runnerSheetsHtml } from "../src/printables";
import { decodeSnapshot, encodeSnapshot, qrSvg, snapshot } from "../src/share";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

function dinner() {
  const tags = ["law", "art", "data", "music", "film", "policy"];
  const hosts = tags.map((t, i) => makeHost(`h${i}`, `${t} table`, t, [t], `Alum ${"ABCDEF"[i]}`));
  const fams = tags.map((t, i) => makeGroup(`f${i}`, `Fam ${i + 1}`, [t], { tableNumber: i + 1, members: [`Student ${i}`] }));
  return planEvent(highs, hosts, fams, 3);
}

describe("volunteer view and runner pages", () => {
  it("a snapshot survives the link, and carries no student names", async () => {
    const p = dinner();
    const s = snapshot(p, "Dinner", "8:31 PM", 2, { f0: "by the stage" });
    const data = await encodeSnapshot(s);
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeSnapshot(data)).toEqual(s);
    expect(JSON.stringify(s)).not.toContain("Student");
    expect(s.f[0]).toEqual([1, "Fam 1", "by the stage"]);
    expect(await decodeSnapshot("not-a-snapshot")).toBeNull();
    expect(qrSvg(`https://example.org/view.html#${data}`)).toMatch(/^<svg/);
  });

  it("runners split the tables, by part of the room when tables have locations", () => {
    const p = dinner();
    expect(runnerGroups(p, 2, {})).toEqual([["f0", "f1", "f2"], ["f3", "f4", "f5"]]);
    const by = runnerGroups(p, 2, { f0: "front", f5: "front", f1: "back", f2: "back", f3: "back", f4: "front" });
    expect(by).toEqual([["f1", "f2", "f3"], ["f0", "f4", "f5"]]);
    const html = runnerSheetsHtml(p, "Dinner", 2, {});
    expect((html.match(/runner \d of 2/g) ?? []).length).toBe(2);
    expect((html.match(/<h3>Round \d<\/h3>/g) ?? []).length).toBe(6);
  });

  it("badges list every alum's table each round", () => {
    const p = dinner();
    const html = hostBadgesHtml(p, "Dinner", {});
    expect((html.match(/class="badge"/g) ?? []).length).toBe(6);
    expect((html.match(/Round 3<\/span><b>Table/g) ?? []).length).toBe(6);
  });
});
