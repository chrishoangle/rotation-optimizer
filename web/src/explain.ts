// Plain-English reasons for one pairing, so a coordinator can answer "why is
// this alum at this fam?" and choose a different host if they know better.

import { tableNumbers } from "./export";
import { pairKey, scoreMatrix } from "./models";
import { EventPlan, hostLabel } from "./planning";

export interface HostOption { hostId: string; label: string; score: number; where: string; current: boolean }
export interface Explanation { lines: string[]; options: HostOption[] }

const has = (m: Record<string, number[]>, id: string, r: number) => (m[id] ?? []).includes(r);

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
}

export function explainPairing(p: EventPlan, round: number, famId: string): Explanation {
  const scores = scoreMatrix(p.hosts, p.fams);
  const tables = tableNumbers(p);
  const fam = p.fams.find((f) => f.groupId === famId)!;
  const a = p.assignments.find((x) => x.round === round && x.groupId === famId);
  const host = a ? p.hosts.find((h) => h.hostId === a.hostId)! : null;
  const seat = (hostId: string, r: number) => p.assignments.find((x) => x.round === r && x.hostId === hostId);
  const lines: string[] = [];

  if (host) {
    const shared = host.tags.filter((t) => fam.interests.includes(t)).sort();
    lines.push(shared.length
      ? `${host.name} and ${fam.name} both list ${list(shared)}, so the pairing scores ${a!.score}.`
      : `${host.name} shares none of ${fam.name}'s interests, so the pairing scores 0.`);
  } else if (has(p.famAway, famId, round)) {
    lines.push(`${fam.name} is cancelled from round ${round}.`);
  } else {
    lines.push(`${fam.name} has no host in round ${round}: there are more fams than host tables this round, and the open tables are shared out as evenly as possible.`);
  }
  if (!fam.interests.length) lines.push(`${fam.name} has no interests listed, so every host scores 0 with it. Add interests to get better matches.`);
  else {
    const anyHost = new Set(p.hosts.flatMap((h) => h.tags));
    const unmatched = fam.interests.filter((t) => !anyHost.has(t)).sort();
    if (unmatched.length) lines.push(`No host lists ${list(unmatched)}, so those interests cannot add to any score.`);
  }

  const ranked = [...p.hosts].sort((x, y) => (scores.get(pairKey(y.hostId, famId)) ?? 0) - (scores.get(pairKey(x.hostId, famId)) ?? 0));
  const best = ranked[0];
  const bestScore = best ? scores.get(pairKey(best.hostId, famId)) ?? 0 : 0;
  if (best && bestScore > 0 && best.hostId !== host?.hostId) {
    const meets = p.assignments.filter((x) => x.hostId === best.hostId && x.groupId === famId).map((x) => x.round);
    const there = seat(best.hostId, round);
    let where: string;
    if (meets.length) where = `meets them in round ${meets.join(" and ")}`;
    else if (has(p.hostAway, best.hostId, round)) where = "is cancelled this round";
    else if (has(p.hostLimits, best.hostId, round)) where = "is not hosting this round";
    else if (there) where = `is at Table ${tables[there.groupId]} this round`;
    else where = "has no table this round";
    lines.push(`The best match for ${fam.name} is ${best.name} (score ${bestScore}), which ${where}.`);
    if (!meets.length) lines.push("The schedule maximizes the total for every fam together, so a fam sometimes gets its second choice when its best match is needed more elsewhere. To insist, choose a host below.");
  }

  const options: HostOption[] = ranked
    .filter((h) => !has(p.hostAway, h.hostId, round) && !has(p.hostLimits, h.hostId, round))
    .map((h) => {
      const s = seat(h.hostId, round);
      const label = hostLabel(h);
      return {
        hostId: h.hostId, label, score: scores.get(pairKey(h.hostId, famId)) ?? 0, current: h.hostId === host?.hostId,
        where: s ? (s.groupId === famId ? "here now" : `now at Table ${tables[s.groupId]}`) : "no table this round",
      };
    });
  return { lines, options };
}

/** Pairings that share at least one interest, out of all the pairings fams have (open tables count as not sharing). */
export function sharedPairings(p: EventPlan): [number, number] {
  const open = Object.entries(p.freeRounds).reduce((n, [f, rs]) => n + rs.filter((r) => !has(p.famAway, f, r)).length, 0);
  return [p.assignments.filter((a) => a.score > 0).length, p.assignments.length + open];
}
