// After a re-plan, what people in the room have to be told: which alumni go
// somewhere different from their printed card, which fams lose or gain a
// host, and a few lines the MC can read out. Printable as change slips, one
// per alum, so a runner can hand them out instead of reprinting whole pages.

import { tableNumbers } from "./export";
import { EventPlan } from "./planning";
import { htmlEscape as e } from "./py";

export interface Move {
  hostId: string;
  round: number;
  /** One sentence for the runner to say to the alum. */
  text: string;
  /** Where the alum goes now, for the slip. */
  now: string;
  /** Where the printed card said. */
  was: string;
}

export interface FamNotice { famId: string; round: number; text: string }

export interface Moves { hosts: Move[]; fams: FamNotice[]; mc: string[] }

const has = (m: Record<string, number[]>, id: string, r: number) => (m[id] ?? []).includes(r);

function seatOf(p: EventPlan, hostId: string, round: number): string | null {
  return p.assignments.find((a) => a.round === round && a.hostId === hostId)?.groupId ?? null;
}

function hostOf(p: EventPlan, famId: string, round: number): string | null {
  return p.assignments.find((a) => a.round === round && a.groupId === famId)?.hostId ?? null;
}

/** "Alum C (Tech)", or just "Tech" without an alum name. */
export function hostLabel(p: EventPlan, hostId: string): string {
  const h = p.hosts.find((x) => x.hostId === hostId)!;
  return h.person ? `${h.person} (${h.name})` : h.name;
}

function tableText(p: EventPlan, famId: string): string {
  const f = p.fams.find((x) => x.groupId === famId)!;
  return `Table ${tableNumbers(p)[famId]} (${f.name})`;
}

/**
 * Everything that differs between what people were told (the printed plan)
 * and the new plan, from round `from` on. Cancelled people are left out:
 * they are not in the room to be told.
 */
export function movesBetween(before: EventPlan, after: EventPlan, from: number): Moves {
  const hosts: Move[] = [];
  const fams: FamNotice[] = [];
  const mc: string[] = [];
  for (let r = from; r <= after.rounds; r++) {
    const lines: string[] = [];
    for (const h of after.hosts) {
      if (has(after.hostAway, h.hostId, r)) continue;
      const known = before.hosts.some((x) => x.hostId === h.hostId);
      const was = known && r <= before.rounds ? seatOf(before, h.hostId, r) : null;
      const now = seatOf(after, h.hostId, r);
      const nowText = now ? tableText(after, now) : "";
      const wasText = was ? tableText(before, was) : "";
      // Same fam at a renumbered table still means walking somewhere else.
      if (was === now && wasText === nowText) continue;
      const who = hostLabel(after, h.hostId);
      let text: string;
      if (now && was === now) {
        const f = after.fams.find((x) => x.groupId === now)!;
        text = `${who}: in round ${r}, ${f.name} is at Table ${tableNumbers(after)[now]}, not Table ${tableNumbers(before)[was!]} as your card says.`;
      } else if (now && was) text = `${who}: in round ${r}, go to ${nowText} instead of ${wasText}.`;
      else if (now && !known) text = `${who}: new host. In round ${r}, go to ${nowText}.`;
      else if (now) text = `${who}: in round ${r}, go to ${nowText}. Your card said you had no table that round.`;
      else if (has(after.hostLimits, h.hostId, r)) continue;
      else text = `${who}: no table in round ${r}. Your card said ${wasText}. Take a break, and thank you.`;
      hosts.push({ hostId: h.hostId, round: r, text, now: now ? nowText : "No table this round", was: was ? wasText : known ? "No table" : "New host" });
      if (now) lines.push(`${h.name} goes to Table ${tableNumbers(after)[now]}`);
    }
    for (const f of after.fams) {
      if (has(after.famAway, f.groupId, r)) continue;
      const was = r <= before.rounds && before.fams.some((x) => x.groupId === f.groupId) ? hostOf(before, f.groupId, r) : null;
      const now = hostOf(after, f.groupId, r);
      if (was && !now) {
        fams.push({ famId: f.groupId, round: r, text: `${tableText(after, f.groupId)} has no host in round ${r}. Let them know before the round, and send a floater if you have one.` });
      }
    }
    if (lines.length) mc.push(`Before round ${r}: ${lines.join(". ")}.`);
  }
  // A host added on the night who still has no table: say so once, with what to do.
  for (const h of after.hosts) {
    if (before.hosts.some((x) => x.hostId === h.hostId)) continue;
    const there = Array.from({ length: after.rounds - from + 1 }, (_, k) => from + k)
      .filter((r) => !has(after.hostAway, h.hostId, r) && !has(after.hostLimits, h.hostId, r));
    if (there.length && there.every((r) => !seatOf(after, h.hostId, r))) {
      hosts.push({ hostId: h.hostId, round: there[0], now: "No table yet", was: "New host",
        text: `${hostLabel(after, h.hostId)}: every fam already has a host, so no table for now. Seat them with a host table that shares their interests.` });
    }
  }
  return { hosts, fams, mc };
}

/** Half-page slips, one per alum who has to go somewhere different. */
export function changeSlipsHtml(p: EventPlan, moves: Move[], title: string, at: string): string {
  const slips = moves.map((m) => `<div class="slip">
<div class="stamp">Change at ${e(at)}</div>
<h2>${e(hostLabel(p, m.hostId))}</h2>
<p class="round">Round ${m.round}</p>
<p class="now">${e(m.now)}</p>
<p class="was">Your card said: ${e(m.was)}</p>
</div>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} change slips</title>
<style>
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; margin: 0; }
@media screen { body { margin: 24px; } }
.slips { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3in; }
.slip { border: 2px dashed #8a8780; border-radius: 10px; padding: 14px 16px; break-inside: avoid; min-height: 2.2in; }
h2 { font-size: 20px; margin: 4px 0; }
.round { font-weight: 700; margin: 6px 0 0; color: #5c5c63; text-transform: uppercase; font-size: 12px; letter-spacing: .05em; }
.now { font-size: 22px; font-weight: 800; margin: 2px 0 8px; }
.was { color: #5c5c63; margin: 0; }
.stamp { display: inline-block; font-size: 12px; font-weight: 700; color: #8a1c1c; border: 1.5px solid #8a1c1c; border-radius: 4px; padding: 1px 6px; }
</style></head><body>
<h1>${e(title)}: change slips</h1>
<p>Cut along the dashed lines and hand each slip to the alum named on it.</p>
<div class="slips">
${slips}
</div>
</body></html>
`;
}
