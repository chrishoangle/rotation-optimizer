import { describe, expect, it } from "vitest";
import { newEvent } from "../src/event";
import { endRound, leftText, startRound, status, toMinutes } from "../src/timing";

const at = (t: string) => toMinutes(t)!;

describe("the clock for the night", () => {
  const event = () => newEvent({ rounds: 3, roundMinutes: 20, startTime: "6:00 PM" });

  it("reads times the way coordinators write them", () => {
    expect([at("6:30 PM"), at("18:30"), at("12:05 AM"), at("12 PM")]).toEqual([1110, 1110, 5, 720]);
    expect(toMinutes("25:00")).toBeNull();
  });

  it("before the start, during a round, and between rounds", () => {
    const s = event();
    expect(status(s, at("6:10 PM"))).toMatchObject({ phase: "before", round: 1, lateBy: 0, plannedEnd: at("7:25 PM") });
    startRound(s, 1, at("6:15 PM"));
    expect(status(s, at("6:27 PM"))).toMatchObject({ phase: "during", minutesLeft: 8, lateBy: 0, projectedEnd: at("7:25 PM") });
    endRound(s, 1, at("6:35 PM")); s.finished = 1;
    expect(status(s, at("6:37 PM"))).toMatchObject({ phase: "moving", round: 2, lateBy: 0 });
    expect(leftText(-2)).toBe("2 minutes over");
  });

  it("running 15 minutes late: says when it now ends, and how short rounds must be to catch up", () => {
    const s = event();
    startRound(s, 1, at("6:15 PM")); endRound(s, 1, at("6:35 PM")); s.finished = 1;
    startRound(s, 2, at("6:55 PM")); // planned 6:40
    const st = status(s, at("7:00 PM"));
    expect(st).toMatchObject({ phase: "during", round: 2, lateBy: 15, minutesLeft: 15, projectedEnd: at("7:40 PM"), plannedEnd: at("7:25 PM") });
    expect(st.catchUp).toBe(12); // rounds 2 and 3 at 12 minutes end at 7:24 PM
    const s2 = event();
    startRound(s2, 1, at("6:25 PM")); // 10 minutes late, 3 rounds still to run
    const st2 = status(s2, at("6:26 PM"));
    expect(st2.lateBy).toBe(10);
    expect(st2.catchUp).toBe(16);
  });

  it("with no doors time, the plan is counted from when round 1 started", () => {
    const s = newEvent({ rounds: 2, roundMinutes: 20 });
    expect(status(s, at("6:00 PM")).plannedEnd).toBeNull();
    startRound(s, 1, at("6:00 PM"));
    expect(status(s, at("6:05 PM")).plannedEnd).toBe(at("6:45 PM"));
  });
});
