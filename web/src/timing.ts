// The clock for the night: when each round actually started and ended,
// how late the event is running, when it will now end, and how long the
// remaining rounds could be to finish on time. Times are minutes after
// midnight; the event file stores them as "18:31".

import type { EventState } from "./event";
import { clock } from "./export";

/** The run sheet's plan: doors, 10 minutes of welcome, 5 to sit, then rounds with 5 minutes to move between them. */
export const WELCOME = 10;
export const SETTLE = 5;
export const SWITCH = 5;

export function toMinutes(text: string): number | null {
  const t = (text || "").trim().toUpperCase().replace(/\./g, "");
  let m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { const h = +m[1], mm = +m[2]; return h < 24 && mm < 60 ? h * 60 + mm : null; }
  m = t.match(/^(\d{1,2})(?::(\d{2}))? ?(AM|PM)$/);
  if (m) { const h = +m[1], mm = m[2] ? +m[2] : 0; return h >= 1 && h <= 12 && mm < 60 ? (h % 12) * 60 + (m[3] === "PM" ? 720 : 0) + mm : null; }
  return null;
}

export const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const shown = (min: number) => clock("00:00", ((min % 1440) + 1440) % 1440);
export const nowMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

function times(s: EventState, r: number): { start: number | null; end: number | null } {
  const t = s.night.roundTimes?.[String(r)] ?? {};
  return { start: t.start ? toMinutes(t.start) : null, end: t.end ? toMinutes(t.end) : null };
}

export function startRound(s: EventState, r: number, at: number): void {
  s.night = { ...s.night, roundTimes: { ...(s.night.roundTimes ?? {}), [String(r)]: { ...(s.night.roundTimes?.[String(r)] ?? {}), start: hhmm(at) } } };
}

export function endRound(s: EventState, r: number, at: number): void {
  s.night = { ...s.night, roundTimes: { ...(s.night.roundTimes ?? {}), [String(r)]: { ...(s.night.roundTimes?.[String(r)] ?? {}), end: hhmm(at) } } };
}

/** When round r was meant to start: from the run sheet's doors time, or from when round 1 actually started. */
export function plannedStart(s: EventState, r: number): number | null {
  const doors = toMinutes(s.startTime);
  const base = doors !== null ? doors + WELCOME + SETTLE : times(s, 1).start;
  return base === null ? null : base + (r - 1) * (s.roundMinutes + SWITCH);
}

export type Phase = "before" | "moving" | "during" | "over";

export interface Status {
  phase: Phase;
  round: number; // the round happening, or about to start
  minutesLeft: number | null; // in the round, when during
  lateBy: number; // minutes behind the plan, never negative
  plannedEnd: number | null;
  projectedEnd: number | null;
  /** Round length that would finish on the planned time, when running late; null when not needed or not possible. */
  catchUp: number | null;
}

export function status(s: EventState, now: number): Status {
  const rounds = s.plan?.rounds ?? s.rounds;
  const r = Math.min(s.finished + 1, rounds);
  const { start, end } = times(s, r);
  const phase: Phase = end !== null && r === rounds ? "over" : start !== null && end === null ? "during" : r === 1 ? "before" : "moving";
  const planned = plannedStart(s, r);
  const plannedEnd = plannedStart(s, rounds) !== null ? plannedStart(s, rounds)! + s.roundMinutes : null;
  let lateBy = 0;
  if (planned !== null) {
    if (start !== null) lateBy = Math.max(0, start - planned);
    else if (phase !== "over") lateBy = Math.max(0, now - planned);
  }
  const minutesLeft = phase === "during" && start !== null ? start + s.roundMinutes - now : null;
  let projectedEnd: number | null = null;
  if (phase === "over") projectedEnd = end;
  else if (phase === "during" && start !== null) projectedEnd = start + s.roundMinutes + (rounds - r) * (s.roundMinutes + SWITCH);
  else projectedEnd = Math.max(now, planned ?? now) + s.roundMinutes + (rounds - r) * (s.roundMinutes + SWITCH);
  let catchUp: number | null = null;
  if (plannedEnd !== null && projectedEnd !== null && projectedEnd - plannedEnd >= 5 && phase !== "over") {
    // Rounds still to start, plus the current one if it is under way and can be shortened.
    const left = rounds - r + 1;
    const from = phase === "during" && start !== null ? start : Math.max(now, planned ?? now);
    const fit = Math.floor((plannedEnd - from - (left - 1) * SWITCH) / left);
    catchUp = fit >= 8 && fit < s.roundMinutes ? fit : null;
  }
  return { phase, round: r, minutesLeft, lateBy, plannedEnd, projectedEnd, catchUp };
}

/** "18 minutes left", "2 minutes over". */
export function leftText(min: number): string {
  if (min >= 0) return `${min} minute${min !== 1 ? "s" : ""} left`;
  return `${-min} minute${min !== -1 ? "s" : ""} over`;
}
