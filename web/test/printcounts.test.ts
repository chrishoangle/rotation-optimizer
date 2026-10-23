// The printouts count people, not tables: a pair is two alumni.

import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEvent, newEvent, saveEvent, solveEvent } from "../src/event";
import { runSheetHtml, seatingChartHtml } from "../src/export";
import type { HighsLike } from "../src/solver";
import { stewDinner } from "../src/stew2026";
import { plannedStart, shown } from "../src/timing";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

describe("counts on paper", () => {
  it("say 13 alumni at 10 tables for the STEW dinner, which has three pairs", () => {
    const p = solveEvent(highs, stewDinner());
    expect(seatingChartHtml(p, "STEW")).toContain("10 fams, 13 alumni at 10 tables, 2 rounds.");
    expect(runSheetHtml(p, "STEW")).toContain("2 rounds, 13 alumni at 10 tables, 10 fams.");
  });

  it("time the open floor and the changeover the same way as the Python run sheet", () => {
    const p = solveEvent(highs, stewDinner());
    const page = runSheetHtml(p, "STEW", "6:30 PM", 25, 10, 10, 30);
    for (const [clock, step] of [["6:50 PM", "Round 1"], ["7:25 PM", "Round 2"], ["7:50 PM", "Open floor"], ["8:20 PM", "Closing"]])
      expect(page).toContain(`<td class="time">${clock}</td><td class="what">${step}</td>`);
  });

  it("save the changeover and open floor only when they differ from the defaults", () => {
    const s = newEvent();
    expect(saveEvent(s)).not.toContain("switch_minutes");
    s.switchMinutes = 10; s.openMinutes = 30;
    const back = loadEvent(saveEvent(s));
    expect([back.switchMinutes, back.openMinutes]).toEqual([10, 30]);
  });

  it("print the STEW 2026 night as it ran: rounds at 6:16 and 6:31, open floor at 6:43, closing at 6:58", () => {
    const s = stewDinner();
    const p = solveEvent(highs, s);
    const page = runSheetHtml(p, "STEW", s.startTime, s.roundMinutes, s.welcomeMinutes, s.switchMinutes, s.openMinutes);
    for (const [clock, step] of [["5:30 PM", "Doors open"], ["6:16 PM", "Round 1"], ["6:31 PM", "Round 2"], ["6:43 PM", "Open floor"], ["6:58 PM", "Closing"]])
      expect(page).toContain(`<td class="time">${clock}</td><td class="what">${step}</td>`);
    // The clock on the night agrees with the paper.
    expect(shown(plannedStart(s, 2, "")!)).toBe("6:31 PM");
    expect(loadEvent(saveEvent(s)).welcomeMinutes).toBe(43);
  });
});
