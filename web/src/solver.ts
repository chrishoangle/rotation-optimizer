// The rotation model, solved in the browser with HiGHS (an open-source
// mixed-integer solver compiled to WebAssembly).
//
// It is the model in docs/algorithm.md, written without placeholders:
//
//   x[h,f,r] = 1 when host h sits with fam f in round r
//   each host sits with at most one fam per round
//   each fam gets at most one host per round (none means an open table)
//   no host and fam meet twice
//   rules, cancellations, and finished rounds remove or fix variables
//
// The objective is the Python solver's: first no fam without any host all
// night, then spread fams' empty rounds evenly (when there are more fams
// than hosts), then keep as many printed slots as possible, then spread
// hosts' empty rounds evenly, then the highest total score,
// then, among equal scores,
// the most real pairings, so no available host sits out while a fam has no
// host. The weights make each level strictly more important than the next,
// and the gap is set to zero, so "Optimal" means proven best.

import { Assignment, GuestGroup, Host, pairKey, scoreMatrix } from "./models";

export interface HighsLike {
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string;
    ObjectiveValue: number;
    Columns: Record<string, { Primal: number }>;
  };
}

export interface ModelInput {
  hosts: Host[];
  fams: GuestGroup[];
  rounds: number;
  required: { hostId: string; famId: string; rounds: number[] }[];
  forbiddenSlots: Set<string>; // slotKey(r, h, f)
  fixedSlots: [number, string, string][];
  preferSlots: [number, string, string][];
  hostAway: Record<string, number[]>; // rounds a host does not sit, cancellations and limits together
  famAway: Record<string, number[]>;
  weakLimit: number | null;
  timeLimitS: number;
  /**
   * Fewest real pairings in every round. The Python solver pads both sides
   * to N places, so at most N - fams hosts can sit out and at most N - hosts
   * fams can have no host; that is H + G - N real pairings per round.
   */
  minPairsPerRound: number;
  /**
   * Real hosts and fams with the rounds each is there, when the event is
   * uneven. Rounds without a partner are spread evenly: the penalty
   * sum over k = 1 .. rounds - 1 of max(0, empty - k) is zero while nobody
   * sits out more than one round, and it ranks above score.
   */
  spreadHosts?: Record<string, number[]> | null;
  spreadFams?: Record<string, number[]> | null;
  /** Hosts who stay with one fam all night: host id to fam id, or "" to let the solver choose. */
  stayHosts?: Record<string, string>;
}

export interface ModelResult {
  status: "optimal" | "feasible" | "infeasible";
  assignments: Assignment[];
  objectiveValue: number;
  objectiveBound: number | null;
  keptSlots: number | null;
  runtimeS: number;
}

export const slotKey = (r: number, h: string, f: string) => `${r}\u0000${h}\u0000${f}`;

export function solveModel(highs: HighsLike, m: ModelInput): ModelResult {
  const scores = scoreMatrix(m.hosts, m.fams);
  const R = m.rounds;
  const away = (map: Record<string, number[]>, id: string, r: number) => (map[id] ?? []).includes(r);
  const name = (hi: number, fi: number, r: number) => `x_${hi}_${fi}_${r}`;
  const vars: { hi: number; fi: number; r: number; v: string; s: number }[] = [];
  const index = new Map<string, string>();
  m.hosts.forEach((h, hi) => m.fams.forEach((f, fi) => {
    for (let r = 1; r <= R; r++) {
      if (away(m.hostAway, h.hostId, r) || away(m.famAway, f.groupId, r)) continue;
      if (m.forbiddenSlots.has(slotKey(r, h.hostId, f.groupId))) continue;
      const v = name(hi, fi, r);
      vars.push({ hi, fi, r, v, s: scores.get(pairKey(h.hostId, f.groupId)) ?? 0 });
      index.set(slotKey(r, h.hostId, f.groupId), v);
    }
  }));

  const cons: string[] = [];
  let c = 0;
  const add = (terms: string[], sense: string, rhs: number) => {
    cons.push(` c${c++}: ` + (terms.length ? terms.map((t) => `+ ${t}`).join(" ") : "0 x_zero") + ` ${sense} ${rhs}`);
  };
  const group = (keyOf: (x: typeof vars[number]) => string) => {
    const out = new Map<string, string[]>();
    for (const x of vars) { const k = keyOf(x); if (!out.has(k)) out.set(k, []); out.get(k)!.push(x.v); }
    return out;
  };
  for (const terms of group((x) => `h${x.hi}r${x.r}`).values()) add(terms, "<=", 1);
  for (const terms of group((x) => `f${x.fi}r${x.r}`).values()) add(terms, "<=", 1);
  const stay = m.stayHosts ?? {};
  const stayIdx = new Set(m.hosts.map((h, hi) => (h.hostId in stay ? hi : -1)).filter((hi) => hi >= 0));
  for (const [key, terms] of group((x) => `p${x.hi}_${x.fi}`)) {
    if (terms.length > 1 && !stayIdx.has(Number(key.slice(1).split("_")[0]))) add(terms, "<=", 1);
  }
  // Staying hosts: one fam all night (y), and with it in every round the slot is allowed.
  const yVars: string[] = [];
  m.hosts.forEach((h, hi) => {
    if (!(h.hostId in stay)) return;
    const want = stay[h.hostId];
    const options = m.fams.map((f, fi) => [f, fi] as const).filter(([f]) => !want || f.groupId === want);
    const ys = options.map(([, fi]) => `y_${hi}_${fi}`);
    yVars.push(...ys);
    add(ys, "=", 1);
    for (const x of vars.filter((v) => v.hi === hi)) {
      const y = `y_${hi}_${x.fi}`;
      if (!ys.includes(y)) { add([x.v], "<=", 0); continue; }
      cons.push(` c${c++}: + ${x.v} - ${y} = 0`);
    }
  });
  let infeasible = false;
  if (m.minPairsPerRound > 0) {
    const byRound = group((x) => `r${x.r}`);
    for (let r = 1; r <= R; r++) {
      const terms = byRound.get(`r${r}`) ?? [];
      if (terms.length < m.minPairsPerRound) infeasible = true;
      else add(terms, ">=", m.minPairsPerRound);
    }
  }

  for (const req of m.required) {
    const allowed = req.rounds.length ? req.rounds : Array.from({ length: R }, (_, k) => k + 1);
    const terms = allowed.map((r) => index.get(slotKey(r, req.hostId, req.famId))).filter((v): v is string => !!v);
    if (!terms.length) infeasible = true;
    else add(terms, "=", 1);
  }
  const fixed: string[] = [];
  for (const [r, h, f] of m.fixedSlots) {
    const v = index.get(slotKey(r, h, f));
    if (!v) infeasible = true;
    else fixed.push(v);
  }
  if (m.weakLimit !== null) {
    m.fams.forEach((f, fi) => {
      const present = Array.from({ length: R }, (_, k) => k + 1).filter((r) => !away(m.famAway, f.groupId, r)).length;
      const good = vars.filter((x) => x.fi === fi && x.s > 0).map((x) => x.v);
      const need = present - m.weakLimit!;
      if (need > 0) {
        if (good.length < need) infeasible = true;
        else add(good, ">=", need);
      }
    });
  }
  if (infeasible) return { status: "infeasible", assignments: [], objectiveValue: 0, objectiveBound: null, keptSlots: null, runtimeS: 0 };

  // Lexicographic weights: score above pair count, kept slots above both.
  const G = m.fams.length;
  const maxScore = Math.max(0, ...vars.map((x) => x.s));
  const k = R * Math.max(G, m.hosts.length) + 1;
  const top = k * R * G * maxScore + R * G;
  const prefer = new Set(m.preferSlots.map(([r, h, f]) => index.get(slotKey(r, h, f))).filter((v): v is string => !!v));
  const penalty: Record<"host" | "fam", string[]> = { host: [], fam: [] };
  const worst = { host: 0, fam: 0 };
  const zero: string[] = [];
  const bounds: string[] = [];
  if (m.spreadHosts && m.spreadFams) {
    const items: ["host" | "fam", number[], string[]][] = [];
    m.hosts.forEach((h, hi) => { if (m.spreadHosts![h.hostId]) items.push(["host", m.spreadHosts![h.hostId], vars.filter((x) => x.hi === hi).map((x) => `${x.r}\u0000${x.v}`)]); });
    m.fams.forEach((f, fi) => { if (m.spreadFams![f.groupId]) items.push(["fam", m.spreadFams![f.groupId], vars.filter((x) => x.fi === fi).map((x) => `${x.r}\u0000${x.v}`)]); });
    let n = 0;
    for (const [kind, rs, tagged] of items) {
      const avail = [...new Set(rs)];
      if (avail.length < 2) continue;
      const set = new Set(avail.map(String));
      const terms = tagged.filter((t) => set.has(t.split("\u0000")[0])).map((t) => t.split("\u0000")[1]);
      for (let j = 1; j < avail.length; j++) {
        const e = `e_${n++}`;
        penalty[kind].push(e);
        add([e, ...terms], ">=", avail.length - j);
        bounds.push(` 0 <= ${e} <= ${avail.length - j}`);
        worst[kind] += avail.length - j;
      }
    }
    m.fams.forEach((f, fi) => {
      const rs = m.spreadFams![f.groupId];
      if (!rs || !rs.length) return;
      const set = new Set(rs);
      const terms = vars.filter((x) => x.fi === fi && set.has(x.r)).map((x) => x.v);
      const z = `z_${zero.length}`;
      zero.push(z);
      add([z, ...terms], ">=", 1);
      bounds.push(` 0 <= ${z} <= 1`);
    });
  }
  // Each level outweighs everything below it (see the header comment).
  const hostWeight = top + 1;
  const keptWeight = hostWeight * (worst.host + 1);
  const famWeight = keptWeight * (prefer.size + 1);
  const zeroWeight = famWeight * (worst.fam + 1);
  const coef = new Map<string, number>();
  for (const x of vars) coef.set(x.v, k * x.s + 1 + (prefer.has(x.v) ? keptWeight : 0));
  const objTerms = [
    ...vars.map((x) => `+ ${coef.get(x.v)} ${x.v}`),
    ...penalty.host.map((e) => `- ${hostWeight} ${e}`), ...penalty.fam.map((e) => `- ${famWeight} ${e}`),
    ...zero.map((z) => `- ${zeroWeight} ${z}`),
  ];

  const lp = [
    "Maximize",
    " obj: " + (objTerms.length ? objTerms.join(" ") : "0 x_zero"),
    "Subject To",
    ...cons,
    ...(cons.length ? [] : [" c_empty: 0 x_zero >= 0"]),
    "Bounds",
    ...fixed.map((v) => ` ${v} = 1`),
    ...bounds,
    "Binary",
    " " + ([...vars.map((x) => x.v), ...yVars].join(" ") || "x_zero"),
    "End",
    "",
  ].join("\n");
  const start = performance.now();
  const res = highs.solve(lp, { time_limit: m.timeLimitS, mip_rel_gap: 0, mip_abs_gap: 0.5, output_flag: false });
  const runtimeS = (performance.now() - start) / 1000;
  if (res.Status === "Infeasible") {
    return { status: "infeasible", assignments: [], objectiveValue: 0, objectiveBound: null, keptSlots: null, runtimeS };
  }
  const assignments: Assignment[] = [];
  let kept = 0;
  for (const x of vars) {
    if ((res.Columns[x.v]?.Primal ?? 0) > 0.5) {
      assignments.push({ round: x.r, hostId: m.hosts[x.hi].hostId, groupId: m.fams[x.fi].groupId, score: x.s });
      if (prefer.has(x.v)) kept++;
    }
  }
  if (!assignments.length && vars.length && res.Status !== "Optimal") {
    return { status: "infeasible", assignments: [], objectiveValue: 0, objectiveBound: null, keptSlots: null, runtimeS };
  }
  const value = Math.round(res.ObjectiveValue);
  const optimal = res.Status === "Optimal";
  return {
    status: optimal ? "optimal" : "feasible",
    assignments,
    objectiveValue: value,
    objectiveBound: optimal ? value : null,
    keptSlots: m.preferSlots.length ? kept : null,
    runtimeS,
  };
}
