// Planning a real event: rules, cancellations, finished rounds, warnings,
// and what to reprint. A port of src/rotation_optimizer/planning.py with the
// same plain-language messages.

import { Assignment, GuestGroup, Host, pairKey, scoreMatrix } from "./models";
import { roundText, upperFirst } from "./py";
import type { Rule } from "./sheets";
import { HighsLike, slotKey, solveModel } from "./solver";

export const NO_HOST = "Open table (no host)";
export const FAM_ABSENT = "Not attending this round";

export class InfeasibleProblemError extends Error {}
export class RuleConflictError extends InfeasibleProblemError {}

export interface EventPlan {
  hosts: Host[];
  fams: GuestGroup[];
  rounds: number;
  assignments: Assignment[];
  freeRounds: Record<string, number[]>;
  hostBreaks: Record<string, number[]>;
  totalScore: number;
  objectiveBound: number | null;
  runtimeS: number;
  warnings: string[];
  rules: Rule[];
  hostAway: Record<string, number[]>; // cancellations made on the night
  hostLimits: Record<string, number[]>; // rounds a host is not hosting, from "only in rounds"
  famAway: Record<string, number[]>;
  lockedRounds: number[];
  objectiveValue: number | null;
  keptSlots: number | null;
}

export const provenOptimal = (p: EventPlan) =>
  p.objectiveBound !== null && p.objectiveBound === (p.objectiveValue ?? p.totalScore);
export const zeroSlots = (p: EventPlan) => p.assignments.filter((a) => a.score === 0);
export function openSlots(p: EventPlan): [number, string][] {
  const out: [number, string][] = [];
  for (const [f, rs] of Object.entries(p.freeRounds)) for (const r of rs) if (!(p.famAway[f] ?? []).includes(r)) out.push([r, f]);
  return out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}
export const weakCount = (p: EventPlan) => zeroSlots(p).length + openSlots(p).length;
export const hostName = (p: EventPlan, id: string) => p.hosts.find((h) => h.hostId === id)!.name;
export const famName = (p: EventPlan, id: string) => p.fams.find((f) => f.groupId === id)!.name;
export const slots = (p: EventPlan) => new Set(p.assignments.map((a) => slotKey(a.round, a.hostId, a.groupId)));

const range = (n: number) => Array.from({ length: n }, (_, k) => k + 1);

export function vocabularyWarnings(hosts: Host[], fams: GuestGroup[]): string[] {
  const hostTags = new Set(hosts.flatMap((h) => h.tags));
  const famTags = new Set(fams.flatMap((f) => f.interests));
  const out: string[] = [];
  const unusedHost = [...hostTags].filter((t) => !famTags.has(t)).sort();
  const unusedFam = [...famTags].filter((t) => !hostTags.has(t)).sort();
  if (unusedHost.length) out.push("Host tags that no fam lists, so they never add to a score: " + unusedHost.join(", ") + ".");
  if (unusedFam.length) out.push("Fam interests that no host lists, so they never add to a score: " + unusedFam.join(", ") + ".");
  const scores = scoreMatrix(hosts, fams);
  for (const f of fams) {
    if (hosts.every((h) => scores.get(pairKey(h.hostId, f.groupId)) === 0)) {
      out.push(`No host shares any tag with ${f.name}. Every round will score 0 for this fam.`);
    }
  }
  return out;
}

function checkRules(
  hosts: Host[], fams: GuestGroup[], rounds: number, rules: Rule[],
  hostAway: Record<string, number[]>, famAway: Record<string, number[]>,
  locked: [number, string, string][], hostLimits: Record<string, number[]>,
): void {
  const hname = Object.fromEntries(hosts.map((h) => [h.hostId, h.name]));
  const fname = Object.fromEntries(fams.map((f) => [f.groupId, f.name]));
  const allRounds = new Set(range(rounds));
  const problems: string[] = [];
  const known = (text: string, h: string | null, f: string | null) => {
    let ok = true;
    if (h !== null && !(h in hname)) { problems.push(`${text} names a host table that is not in the hosts sheet (${h}).`); ok = false; }
    if (f !== null && !(f in fname)) { problems.push(`${text} names a fam that is not in the fams sheet (${f}).`); ok = false; }
    return ok;
  };
  for (const [h, rs] of Object.entries(hostAway)) {
    if (known("A cancellation", h, null)) for (const r of rs) if (!allRounds.has(r)) problems.push(`${hname[h]} is cancelled from round ${r}, but the event has ${rounds} rounds.`);
  }
  for (const [f, rs] of Object.entries(famAway)) {
    if (known("A cancellation", null, f)) for (const r of rs) if (!allRounds.has(r)) problems.push(`${fname[f]} is cancelled from round ${r}, but the event has ${rounds} rounds.`);
  }
  const musts = rules.filter((r) => r.kind === "must");
  const nevers = rules.filter((r) => r.kind === "never");
  for (const rule of rules) {
    if (rule.kind !== "must" && rule.kind !== "never") { problems.push(`Unknown rule type '${rule.kind}'. Use must or never.`); continue; }
    if (!known(`A ${rule.kind} rule`, rule.hostId, rule.famId)) continue;
    const bad = rule.rounds.filter((r) => !allRounds.has(r));
    if (bad.length) {
      problems.push(`The rule ${hname[rule.hostId]} ${rule.kind} meet ${fname[rule.famId]} mentions round ${bad[0]}, but the event has ${rounds} rounds.`);
    }
  }
  if (problems.length) throw new RuleConflictError(problems.join("\n"));

  const lockedSet = new Set(locked.map(([r, h, f]) => slotKey(r, h, f)));
  const lockedRounds = new Set(locked.map(([r]) => r));
  for (const m of musts) {
    const allowed = new Set(m.rounds.length ? m.rounds : allRounds);
    const h = hname[m.hostId], f = fname[m.famId];
    const label = `${h} must meet ${f}` + (m.rounds.length ? ` in ${roundText(m.rounds)}` : "");
    for (const n of nevers) {
      if (n.hostId === m.hostId && n.famId === m.famId) {
        const blocked = new Set(n.rounds.length ? n.rounds : allRounds);
        if ([...allowed].every((r) => blocked.has(r))) {
          problems.push(`The rule ${label} conflicts with the rule ${h} never meet ${f}` + (n.rounds.length ? ` in ${roundText(n.rounds)}` : "") + ". Remove one of them.");
        }
      }
    }
    const limited = new Set(hostLimits[m.hostId] ?? []);
    const hAway = new Set(hostAway[m.hostId] ?? []);
    const fAway = new Set(famAway[m.famId] ?? []);
    const open = [...allowed].filter((r) => !hAway.has(r) && !limited.has(r) && !fAway.has(r));
    if (!open.length) {
      const why: string[] = [];
      const allowedLimited = [...allowed].some((r) => limited.has(r));
      const allowedAway = [...allowed].filter((r) => hAway.has(r));
      if (allowedLimited) why.push(`${h} only comes for ${roundText([...allRounds].filter((r) => !limited.has(r)))} (pairing rule)`);
      if (allowedAway.length) why.push(`${h} is cancelled from ${roundText(allowedAway)}`);
      const famGone = [...allowed].filter((r) => fAway.has(r));
      if (famGone.length) why.push(`${f} is cancelled from ${roundText(famGone)}`);
      const fix = allowedLimited && !allowedAway.length ? ". Change one of the two rules." : ". Remove that rule, or change its rounds, then re-plan.";
      problems.push(`The rule ${label} cannot hold because ` + why.join(" and ") + fix);
    }
    const lockedMet = [...allowed].some((r) => lockedSet.has(slotKey(r, m.hostId, m.famId)));
    if (!lockedMet && [...allowed].every((r) => lockedRounds.has(r))) {
      problems.push(`The rule ${label} cannot hold because ${roundText(allowed)} already happened without that pairing. Remove that rule, then re-plan.`);
    }
  }
  const byHostRound = new Map<string, string[]>();
  const byFamRound = new Map<string, string[]>();
  for (const m of musts) {
    if (m.rounds.length === 1) {
      const r = m.rounds[0];
      const hk = `${m.hostId}\u0000${r}`, fk = `${m.famId}\u0000${r}`;
      if (!byHostRound.has(hk)) byHostRound.set(hk, []);
      byHostRound.get(hk)!.push(m.famId);
      if (!byFamRound.has(fk)) byFamRound.set(fk, []);
      byFamRound.get(fk)!.push(m.hostId);
    }
  }
  for (const [k, fs] of byHostRound) {
    const [h, r] = k.split("\u0000");
    if (fs.length > 1) problems.push(`${hname[h]} has must rules with ${fs.map((f) => fname[f]).join(", ")} all in round ${r}, but a host can sit at only one table per round. Move one rule to another round.`);
  }
  for (const [k, hs] of byFamRound) {
    const [f, r] = k.split("\u0000");
    if (hs.length > 1) problems.push(`${fname[f]} has must rules with ${hs.map((h) => hname[h]).join(", ")} all in round ${r}, but a fam gets only one host per round. Move one rule to another round.`);
  }
  if (problems.length) throw new RuleConflictError(problems.join("\n"));
}

export interface PlanOptions {
  rules?: Rule[];
  hostAway?: Record<string, number[]>;
  famAway?: Record<string, number[]>;
  locked?: [number, string, string][];
  keep?: [number, string, string][];
  hostLimits?: Record<string, number[]>;
  weakLimit?: number | null;
  timeLimitS?: number;
  diagnose?: boolean;
}

const normal = (m: Record<string, number[]> = {}) =>
  Object.fromEntries(Object.entries(m).filter(([, rs]) => rs.length).map(([k, rs]) => [k, [...new Set(rs)].sort((a, b) => a - b)]));

export function planEvent(highs: HighsLike, hosts: Host[], fams: GuestGroup[], rounds: number, o: PlanOptions = {}): EventPlan {
  if (!hosts.length || !fams.length) throw new InfeasibleProblemError("need at least one host and one fam");
  if (rounds < 1) throw new InfeasibleProblemError(`rounds must be at least 1, got ${rounds}`);
  const rules = o.rules ?? [];
  const cancelled = normal(o.hostAway);
  const hostLimits = normal(o.hostLimits);
  const famAway = normal(o.famAway);
  const lockedKeys = new Set<string>();
  const locked = (o.locked ?? []).filter(([r, h, f]) => {
    const k = slotKey(r, h, f);
    if (lockedKeys.has(k)) return false;
    lockedKeys.add(k);
    return true;
  });
  const timeLimitS = o.timeLimitS ?? 30;
  checkRules(hosts, fams, rounds, rules, cancelled, famAway, locked, hostLimits);
  const hostAway: Record<string, number[]> = {};
  for (const h of new Set([...Object.keys(cancelled), ...Object.keys(hostLimits)])) {
    hostAway[h] = [...new Set([...(cancelled[h] ?? []), ...(hostLimits[h] ?? [])])].sort((a, b) => a - b);
  }
  for (const [r, h, f] of locked) {
    if ((hostAway[h] ?? []).includes(r) || (famAway[f] ?? []).includes(r)) {
      throw new RuleConflictError(
        `Round ${r} already happened with ${hosts.find((x) => x.hostId === h)!.name} at ${fams.find((x) => x.groupId === f)!.name}, ` +
        `but one of them is cancelled from round ${r}. A finished round cannot change.`,
      );
    }
  }
  const mostAway = (away: Record<string, number[]>) => Math.max(0, ...range(rounds).map((r) => Object.values(away).filter((rs) => rs.includes(r)).length));
  const n = Math.max(hosts.length + mostAway(famAway), fams.length + mostAway(hostAway));
  if (rounds > n) {
    throw new InfeasibleProblemError(
      `With ${hosts.length} host tables and ${fams.length} fams, the most rounds without any fam meeting the same host twice is ${n}. ` +
      `Lower the number of rounds to ${n} or fewer.`,
    );
  }
  const hostIds = new Set(hosts.map((h) => h.hostId));
  const famIds = new Set(fams.map((f) => f.groupId));
  const forbidden = new Set<string>();
  const lockedRounds = new Set(locked.map(([r]) => r));
  for (const r of lockedRounds) for (const h of hostIds) for (const f of famIds) if (!lockedKeys.has(slotKey(r, h, f))) forbidden.add(slotKey(r, h, f));
  for (const nv of rules.filter((x) => x.kind === "never")) {
    for (const r of nv.rounds.length ? nv.rounds : range(rounds)) forbidden.add(slotKey(r, nv.hostId, nv.famId));
  }
  const keep = (o.keep ?? []).filter(([r, h, f]) => !lockedRounds.has(r) && r <= rounds && hostIds.has(h) && famIds.has(f));
  const result = solveModel(highs, {
    hosts, fams, rounds,
    required: rules.filter((x) => x.kind === "must").map((x) => ({ hostId: x.hostId, famId: x.famId, rounds: x.rounds })),
    forbiddenSlots: forbidden, fixedSlots: locked, preferSlots: keep, hostAway, famAway,
    weakLimit: o.weakLimit ?? null, timeLimitS, minPairsPerRound: hosts.length + fams.length - n,
  });
  if (result.status === "infeasible") {
    if (o.diagnose === false) throw new RuleConflictError("No schedule satisfies every rule.");
    throw new RuleConflictError(explainConflict(highs, hosts, fams, rounds, rules, cancelled, famAway, locked, hostLimits, o.weakLimit ?? null));
  }
  const real = [...result.assignments].sort((a, b) => a.round - b.round || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
  const freeRounds: Record<string, number[]> = {};
  for (const f of fams) {
    const rs = range(rounds).filter((r) => !real.some((a) => a.round === r && a.groupId === f.groupId));
    if (rs.length) freeRounds[f.groupId] = rs;
  }
  const hostBreaks: Record<string, number[]> = {};
  for (const h of hosts) {
    const rs = range(rounds).filter((r) => !real.some((a) => a.round === r && a.hostId === h.hostId));
    if (rs.length) hostBreaks[h.hostId] = rs;
  }
  const warnings = [
    ...vocabularyWarnings(hosts, fams),
    ...fairnessWarnings(fams, real, rounds, famAway, Object.fromEntries(hosts.map((h) => [h.hostId, h.name]))),
  ];
  if (result.status !== "optimal") warnings.push(`The solver stopped at the ${Math.round(timeLimitS)} s limit before proving this is the best schedule.`);
  return {
    hosts, fams, rounds, assignments: real, freeRounds, hostBreaks,
    totalScore: real.reduce((s, a) => s + a.score, 0),
    objectiveBound: result.objectiveBound, runtimeS: result.runtimeS, warnings, rules,
    hostAway: cancelled, hostLimits, famAway, lockedRounds: [...lockedRounds].sort((a, b) => a - b),
    objectiveValue: result.objectiveValue, keptSlots: result.keptSlots,
  };
}

function explainConflict(
  highs: HighsLike, hosts: Host[], fams: GuestGroup[], rounds: number, rules: Rule[],
  hostAway: Record<string, number[]>, famAway: Record<string, number[]>, locked: [number, string, string][],
  hostLimits: Record<string, number[]>, weakLimit: number | null,
): string {
  const hname = Object.fromEntries(hosts.map((h) => [h.hostId, h.name]));
  const fname = Object.fromEntries(fams.map((f) => [f.groupId, f.name]));
  const all = range(rounds);
  const items: string[] = [];
  const words: Record<string, string> = {};
  rules.forEach((rule, i) => {
    const k = `rule\u0000${i}`;
    items.push(k);
    const when = rule.rounds.length ? ` in ${roundText(rule.rounds)}` : "";
    words[k] = `${hname[rule.hostId]} ${rule.kind === "must" ? "must meet" : "never meets"} ${fname[rule.famId]}${when}`;
  });
  for (const [h, rs] of Object.entries(hostLimits)) {
    const k = `limit\u0000${h}`; items.push(k);
    words[k] = `${hname[h]} only comes for ${roundText(all.filter((r) => !rs.includes(r)))}`;
  }
  for (const [h, rs] of Object.entries(hostAway)) { const k = `host_away\u0000${h}`; items.push(k); words[k] = `${hname[h]} is cancelled from round ${Math.min(...rs)}`; }
  for (const [f, rs] of Object.entries(famAway)) { const k = `fam_away\u0000${f}`; items.push(k); words[k] = `${fname[f]} is cancelled from round ${Math.min(...rs)}`; }
  if (weakLimit !== null) { items.push("weak\u0000"); words["weak\u0000"] = "the setting No fam gets more than one weak round"; }
  if (locked.length) {
    items.push("locked\u0000");
    words["locked\u0000"] = upperFirst(roundText([...new Set(locked.map(([r]) => r))])) + " already happened";
  }
  const feasible = (keep: string[]) => {
    const k = new Set(keep);
    try {
      planEvent(highs, hosts, fams, rounds, {
        timeLimitS: 10,
        rules: rules.filter((_, i) => k.has(`rule\u0000${i}`)),
        hostAway: Object.fromEntries(Object.entries(hostAway).filter(([h]) => k.has(`host_away\u0000${h}`))),
        famAway: Object.fromEntries(Object.entries(famAway).filter(([f]) => k.has(`fam_away\u0000${f}`))),
        hostLimits: Object.fromEntries(Object.entries(hostLimits).filter(([h]) => k.has(`limit\u0000${h}`))),
        locked: k.has("locked\u0000") ? locked : [],
        weakLimit: k.has("weak\u0000") ? weakLimit : null,
        diagnose: false,
      });
      return true;
    } catch (err) {
      if (err instanceof InfeasibleProblemError) return false;
      throw err;
    }
  };
  let core = [...items];
  for (const item of items) {
    const trial = core.filter((x) => x !== item);
    if (!feasible(trial)) core = trial;
  }
  if (!core.length) return "No schedule fits these tables and rounds. Lower the number of rounds, or add host tables or fams.";
  const named = core.map((x) => words[x]);
  if (named.length === 1) return `${upperFirst(named[0])} cannot be met with these tables and rounds. Change it or delete it.`;
  return "These cannot all hold at once: " + named.join("; ") + ". Change a round, or delete one of them.";
}

function roundsWords(rounds: number[]): string {
  if (rounds.length === 1) return `round ${rounds[0]}`;
  return "rounds " + rounds.slice(0, -1).join(", ") + ` and ${rounds[rounds.length - 1]}`;
}

export function fairnessWarnings(
  fams: GuestGroup[], real: Assignment[], rounds: number, famAway: Record<string, number[]>, hostNames: Record<string, string>,
): string[] {
  const bySlot = new Map(real.map((a) => [`${a.round}\u0000${a.groupId}`, a]));
  const out: string[] = [];
  const flagged = new Set<string>();
  for (const f of fams) {
    const weak: string[] = [];
    for (const r of range(rounds)) {
      if ((famAway[f.groupId] ?? []).includes(r)) continue;
      const a = bySlot.get(`${r}\u0000${f.groupId}`);
      if (!a) weak.push(`round ${r}: no host`);
      else if (a.score === 0) weak.push(`round ${r}: ${hostNames[a.hostId]}, no shared interests`);
    }
    if (weak.length > 1) {
      out.push(`Fairness check: ${f.name} gets no host or a 0-score host in ${weak.length} rounds (` + weak.join("; ") + "). Consider a must meet rule for this fam.");
      flagged.add(f.name);
    }
  }
  const totals = new Map(fams.map((f) => [f.groupId, real.filter((a) => a.groupId === f.groupId).reduce((s, a) => s + a.score, 0)]));
  const ordered = [...totals.values()].sort((a, b) => a - b);
  const median = ordered.length ? ordered[Math.floor(ordered.length / 2)] : 0;
  for (const f of fams) {
    if (flagged.has(f.name) || median === 0) continue;
    const total = totals.get(f.groupId)!;
    if (total < 0.4 * median) {
      const hosted = new Set(real.filter((a) => a.groupId === f.groupId).map((a) => a.round));
      const away = new Set(famAway[f.groupId] ?? []);
      const empty = range(rounds).filter((r) => !hosted.has(r) && !away.has(r));
      const why = empty.length ? " It had no host in " + roundsWords(empty) + "." : "";
      out.push(
        `Fairness check: ${f.name} scores ${total} in total, far below the typical fam (${median}).${why} Consider a must meet rule for this fam, or turn on "No fam gets more than one weak round".`,
      );
    }
  }
  return out;
}

export interface SlotChange { round: number; famId: string; before: string | null; after: string | null }

export function planChanges(old: EventPlan, next: EventPlan): SlotChange[] {
  const table = (p: EventPlan) => new Map(p.assignments.map((a) => [`${a.round}\u0000${a.groupId}`, a.hostId]));
  const a = table(old), b = table(next);
  const out: SlotChange[] = [];
  for (const r of range(next.rounds)) for (const f of next.fams) {
    const k = `${r}\u0000${f.groupId}`;
    if ((a.get(k) ?? null) !== (b.get(k) ?? null)) out.push({ round: r, famId: f.groupId, before: a.get(k) ?? null, after: b.get(k) ?? null });
  }
  return out;
}

export function slotText(p: EventPlan, round: number, famId: string): string {
  const a = p.assignments.find((x) => x.round === round && x.groupId === famId);
  if (a) return hostName(p, a.hostId);
  if ((p.famAway[famId] ?? []).includes(round)) return FAM_ABSENT;
  return NO_HOST;
}

export interface Reprint { hostIds: string[]; famIds: string[]; seatingChart: boolean; seatingRounds: number[]; finderPage: boolean }

export function describeReprint(out: Reprint, p: EventPlan): string[] {
  const items = out.hostIds.map((h) => `host card for ${hostName(p, h)}`);
  items.push(...out.famIds.map((f) => `table tent for ${famName(p, f)}`));
  const pages = out.seatingRounds.map((r) => `round ${r} page`).concat(out.finderPage ? ["find-your-table page"] : []);
  if (pages.length) items.push("seating chart, " + pages.join(" and "));
  return items;
}

function card(p: EventPlan, hostId: string): Map<number, string> {
  const host = p.hosts.find((h) => h.hostId === hostId);
  const head = JSON.stringify(host ? [host.name, host.person] : [null, null]);
  const out = new Map<number, string>();
  for (const r of range(p.rounds)) {
    const a = p.assignments.find((x) => x.hostId === hostId && x.round === r);
    if (!a) out.set(r, head + "|null");
    else {
      const f = p.fams.find((x) => x.groupId === a.groupId)!;
      out.set(r, head + "|" + JSON.stringify([f.tableNumber, f.name, f.interests]));
    }
  }
  return out;
}

export function reprintList(printed: EventPlan, next: EventPlan): Reprint {
  const hostIds = [...new Set([...printed.hosts.map((h) => h.hostId), ...next.hosts.map((h) => h.hostId)])].sort();
  const reprintHosts: string[] = [];
  for (const h of hostIds) {
    const before = card(printed, h), after = card(next, h);
    const changed = range(Math.max(printed.rounds, next.rounds)).filter((r) => before.get(r) !== after.get(r));
    const present = changed.filter((r) => !(next.hostAway[h] ?? []).includes(r) || r > next.rounds);
    if (present.length && next.hosts.some((x) => x.hostId === h)) reprintHosts.push(h);
  }
  const oldTents = new Map(printed.fams.map((f) => [f.groupId, JSON.stringify([f.name, f.tableNumber])]));
  const tents = next.fams.filter((f) => oldTents.get(f.groupId) !== JSON.stringify([f.name, f.tableNumber])).map((f) => f.groupId);
  const rounds = new Set(planChanges(printed, next).map((c) => c.round));
  const notes = (p: EventPlan, r: number) => JSON.stringify([
    Object.entries(p.hostAway).filter(([, rs]) => rs.includes(r)).map(([h]) => h).sort(),
    Object.entries(p.hostLimits).filter(([, rs]) => rs.includes(r)).map(([h]) => h).sort(),
    Object.entries(p.hostBreaks).filter(([, rs]) => rs.includes(r)).map(([h]) => h).sort(),
  ]);
  for (const r of range(next.rounds)) if (notes(printed, r) !== notes(next, r)) rounds.add(r);
  const names = (p: EventPlan) => JSON.stringify(Object.fromEntries(p.hosts.map((h) => [h.hostId, h.name]).sort()));
  if (tents.length || printed.rounds !== next.rounds || names(printed) !== names(next)) for (const r of range(next.rounds)) rounds.add(r);
  const oldMembers = new Map(printed.fams.map((f) => [f.groupId, JSON.stringify([f.name, f.tableNumber, f.members])]));
  const finder = next.fams.some((f) => f.members.length && oldMembers.get(f.groupId) !== JSON.stringify([f.name, f.tableNumber, f.members]));
  const seatingRounds = [...rounds].sort((a, b) => a - b);
  return { hostIds: reprintHosts, famIds: tents, seatingChart: !!(seatingRounds.length || finder), seatingRounds, finderPage: finder };
}
