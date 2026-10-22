"""CP-SAT formulation of the rotation assignment problem.

PROBLEM
-------
Given:
  - H hosts (indexed h = 0..H-1)
  - G guest groups (indexed g = 0..G-1), with H == G required
  - R rounds (indexed r = 0..R-1)
  - A score matrix s[h, g] : int, representing match quality

Find an assignment x[h, g, r] ∈ {0, 1} such that:

  (C1) Every host hosts exactly one group each round:
         Σ_g x[h, g, r] = 1   for all h, r

  (C2) Every group is hosted by exactly one host each round:
         Σ_h x[h, g, r] = 1   for all g, r

  (C3) No (host, group) pair repeats across rounds:
         Σ_r x[h, g, r] ≤ 1   for all (h, g)

Maximizing:
         Σ_{h,g,r} s[h, g] * x[h, g, r]

Optional rules, added on top of C1 to C3 and never replacing them:

  (R1) Required pair (h, g) meets once within its allowed rounds A, which
       default to all rounds:                    Σ_{r in A} x[h, g, r] = 1
  (R2) Forbidden pair (h, g) never meets:         Σ_r x[h, g, r] = 0
  (R3) Fixed slot (r, h, g) is in the schedule:   x[h, g, r] = 1
  (R4) Forbidden slot (r, h, g) is not:           x[h, g, r] = 0

Keeping an existing schedule (used when re-planning after a cancellation):
given preferred slots P, the objective becomes

         W * Σ_{(h,g,r) in P} x[h, g, r]  +  Σ_{h,g,r} s[h, g] * x[h, g, r]

with W = R * G * max(s) + 1. Every kept slot is worth more than the largest
possible total score, so the solver first keeps as many preferred slots as
the rules allow, then maximizes score among those schedules.

Tie-break (used by plan_event for padded events): given preferred pairs Q,
for example real host and real group pairs as opposed to placeholders,
the score term is multiplied by K = R * G + 1 and Σ_{(h,g) in Q, r} x[h,g,r]
is added. The tie-break can never outweigh one point of score, so it only
chooses among schedules with equal score. Match scores are unchanged.

Weak-round limit (optional): for each group g in L, at most M rounds may
pair it with a host scoring 0 with it:  Σ_{h: s[h,g]=0, r} x[h,g,r] <= M.

WHY CP-SAT
----------
Every variable is boolean and every coefficient is an integer, so the model
fits CP-SAT without scaling. CP-SAT also reports a best objective bound. When
the bound equals the returned score, the schedule is proven optimal. See
docs/algorithm.md for measured runtimes and the problem sizes where that
proof arrives in under one second.
"""

from __future__ import annotations

import time
from typing import Iterable

from ortools.sat.python import cp_model

from .models import Assignment, GuestGroup, Host, Schedule
from .scoring import Scorer, build_score_matrix, tag_overlap_score


class InfeasibleProblemError(RuntimeError):
    """Raised when the constraints cannot be satisfied (e.g., R > H)."""


DEFAULT_WORKERS = 8


def solve(
    hosts: list[Host],
    groups: list[GuestGroup],
    rounds: int,
    *,
    scorer: Scorer = tag_overlap_score,
    time_limit_s: float = 30.0,
    num_workers: int | None = None,
    required_pairs: Iterable[tuple] = (),
    forbidden_pairs: Iterable[tuple[str, str]] = (),
    fixed_slots: Iterable[tuple[int, str, str]] = (),
    forbidden_slots: Iterable[tuple[int, str, str]] = (),
    prefer_slots: Iterable[tuple[int, str, str]] = (),
    tiebreak_pairs: Iterable[tuple[str, str]] = (),
    weak_limit: int | None = None,
    weak_groups: Iterable[str] = (),
    repeat_ok: Iterable[str] = (),
) -> Schedule:
    """Return the optimal (or best-found) rotation schedule.

    Preconditions:
      - len(hosts) == len(groups): one host per table per round
      - rounds <= len(hosts): otherwise C3 (no repeats) is infeasible,
        since each host can visit each group at most once

    Raises InfeasibleProblemError if preconditions fail or the solver
    cannot find any feasible assignment within time_limit_s.

    Rules use ids, and rounds are 1-indexed like Assignment.round_number:
      required_pairs: (host_id, group_id) pairs that must meet once (R1), or
        (host_id, group_id, rounds) to require the meeting within those rounds.
      forbidden_pairs: (host_id, group_id) pairs that must never meet (R2).
      fixed_slots: (round, host_id, group_id) slots that must be used (R3),
        for example a round that already happened.
      forbidden_slots: (round, host_id, group_id) slots that must not be
        used (R4), for example a host who has left.
      prefer_slots: (round, host_id, group_id) slots to keep where possible.
        Keeping them takes strict priority over score (see the module
        docstring). The returned Schedule reports kept_slots, and
        objective_value is the weighted objective.
      tiebreak_pairs: (host_id, group_id) pairs preferred when scores tie.
      weak_limit, weak_groups: at most weak_limit rounds per listed group
        with a host that scores 0 with it.
      repeat_ok: host or group ids exempt from C3. plan_event() passes its
        placeholders ("Open table" hosts and "Break" groups), so a fam can
        have no host in two rounds and a cancelled host can sit out two
        rounds. Pairs of two real ids never repeat.
    An unknown id or round raises InfeasibleProblemError before solving.

    A problem can have several optimal schedules with the same score. With
    the parallel search (8 workers unless num_workers is given), which one is returned can change from
    run to run. Pass num_workers=1 for a single-threaded search that returns
    the same schedule on every run with the same OR-Tools version.

    A single worker can be much slower to prove optimality. On the STEW
    example with three rounds, single-worker search had not closed the bound
    after 10 s, while the default search proved the optimum in about 0.07 s
    (Python 3.10.12, OR-Tools 9.15.6755, 4 vCPU aarch64 Linux VM).
    """
    H = len(hosts)
    G = len(groups)
    if H == 0 or G == 0:
        raise InfeasibleProblemError("hosts and groups must both be non-empty")
    if H != G:
        raise InfeasibleProblemError(
            f"host count ({H}) must equal group count ({G}); "
            "pad with placeholder hosts/groups if needed"
        )
    if rounds > H:
        raise InfeasibleProblemError(
            f"rounds ({rounds}) exceeds host count ({H}); "
            "no-repeat constraint cannot be satisfied"
        )
    if rounds < 1:
        raise InfeasibleProblemError(f"rounds must be >= 1, got {rounds}")

    host_index = {h.host_id: i for i, h in enumerate(hosts)}
    group_index = {g.group_id: i for i, g in enumerate(groups)}

    def _pair(item, kind):
        h_id, g_id = item
        if h_id not in host_index or g_id not in group_index:
            raise InfeasibleProblemError(f"{kind} refers to unknown host or group: {h_id}, {g_id}")
        return host_index[h_id], group_index[g_id]

    def _slot(item, kind):
        r, h_id, g_id = item
        if not 1 <= r <= rounds:
            raise InfeasibleProblemError(f"{kind} refers to round {r}, outside 1 to {rounds}")
        h, g = _pair((h_id, g_id), kind)
        return h, g, r - 1

    req: dict[tuple[int, int], frozenset[int]] = {}
    for item in required_pairs:
        h, g = _pair(item[:2], "required pair")
        allowed = item[2] if len(item) > 2 and item[2] else range(1, rounds + 1)
        bad = [r for r in allowed if not 1 <= r <= rounds]
        if bad:
            raise InfeasibleProblemError(f"required pair refers to round {bad[0]}, outside 1 to {rounds}")
        req[h, g] = req.get((h, g), frozenset(range(rounds))) & frozenset(r - 1 for r in allowed)
        if not req[h, g]:
            raise InfeasibleProblemError(
                f"{hosts[h].host_id} and {groups[g].group_id} have required-pair rules with no round in common"
            )
    forb = {_pair(p, "forbidden pair") for p in forbidden_pairs}
    fixed = {_slot(t, "fixed slot") for t in fixed_slots}
    forb_slots = {_slot(t, "forbidden slot") for t in forbidden_slots}
    prefer = {_slot(t, "preferred slot") for t in prefer_slots}
    clash = set(req) & forb
    if clash:
        h, g = sorted(clash)[0]
        raise InfeasibleProblemError(
            f"{hosts[h].host_id} and {groups[g].group_id} are both required and forbidden to meet"
        )
    clash_slots = fixed & forb_slots
    if clash_slots:
        h, g, r = sorted(clash_slots)[0]
        raise InfeasibleProblemError(
            f"round {r + 1}: {hosts[h].host_id} at {groups[g].group_id} is both fixed and forbidden"
        )

    scores = build_score_matrix(hosts, groups, scorer=scorer)
    model = cp_model.CpModel()

    # Decision variables: x[h, g, r] = 1 iff host h is at group g in round r.
    x: dict[tuple[int, int, int], cp_model.IntVar] = {}
    for h in range(H):
        for g in range(G):
            for r in range(rounds):
                x[h, g, r] = model.NewBoolVar(f"x_{h}_{g}_{r}")

    # (C1) Each host hosts exactly one group per round.
    for h in range(H):
        for r in range(rounds):
            model.AddExactlyOne(x[h, g, r] for g in range(G))

    # (C2) Each group is hosted by exactly one host per round.
    for g in range(G):
        for r in range(rounds):
            model.AddExactlyOne(x[h, g, r] for h in range(H))

    # (C3) No (host, group) pair appears in more than one round.
    exempt = set(repeat_ok)
    for h in range(H):
        for g in range(G):
            if hosts[h].host_id in exempt or groups[g].group_id in exempt:
                continue
            model.Add(sum(x[h, g, r] for r in range(rounds)) <= 1)

    # Optional rules (R1 to R4). They only add constraints.
    for (h, g), allowed in req.items():
        model.Add(sum(x[h, g, r] for r in allowed) == 1)
    for h, g in forb:
        for r in range(rounds):
            model.Add(x[h, g, r] == 0)
    for h, g, r in fixed:
        model.Add(x[h, g, r] == 1)
    for h, g, r in forb_slots:
        model.Add(x[h, g, r] == 0)

    # Objective: maximize total match score across all assignments, after
    # keeping as many preferred slots as possible when any are given.
    score_expr = sum(
        scores[hosts[h].host_id, groups[g].group_id] * x[h, g, r]
        for h in range(H)
        for g in range(G)
        for r in range(rounds)
    )
    tie = {_pair(p, "tie-break pair") for p in tiebreak_pairs}
    if tie:
        k = rounds * G + 1
        score_expr = k * score_expr + sum(x[h, g, r] for h, g in tie for r in range(rounds))
        top = k * rounds * G * max(scores.values(), default=0) + rounds * G
    else:
        top = rounds * G * max(scores.values(), default=0)
    if weak_limit is not None:
        for g_id in weak_groups:
            g = group_index[g_id]
            weak = [x[h, g, r] for h in range(H) for r in range(rounds)
                    if scores[hosts[h].host_id, groups[g].group_id] == 0]
            if weak:
                model.Add(sum(weak) <= weak_limit)
    weight = top + 1
    if prefer:
        model.Maximize(weight * sum(x[h, g, r] for h, g, r in prefer) + score_expr)
    else:
        model.Maximize(score_expr)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_s
    # CP-SAT's default is one worker per core. On a 2 core machine, such as a
    # small cloud host, that portfolio could not prove a 3 round example
    # optimal in 30 s; 8 workers proved it in 0.12 s on the same machine.
    solver.parameters.num_workers = num_workers if num_workers is not None else DEFAULT_WORKERS
    start = time.perf_counter()
    status = solver.Solve(model)
    elapsed = time.perf_counter() - start

    if status == cp_model.INFEASIBLE:
        has_rules = bool(req or forb or fixed or forb_slots)
        raise InfeasibleProblemError(
            "no schedule satisfies every rule at once"
            + ("; check required pairs, forbidden pairs, and fixed or forbidden slots" if has_rules else "")
        )
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise InfeasibleProblemError(
            f"solver returned status {solver.StatusName(status)} "
            f"after {elapsed:.3f}s; no feasible schedule found"
        )

    assignments: list[Assignment] = []
    for h in range(H):
        for g in range(G):
            for r in range(rounds):
                if solver.Value(x[h, g, r]) == 1:
                    assignments.append(
                        Assignment(
                            round_number=r + 1,  # 1-indexed for human output
                            host_id=hosts[h].host_id,
                            group_id=groups[g].group_id,
                            score=scores[hosts[h].host_id, groups[g].group_id],
                        )
                    )

    total = sum(a.score for a in assignments)
    kept = sum(1 for h, g, r in prefer if solver.Value(x[h, g, r]) == 1) if prefer else None
    return Schedule(
        assignments=assignments,
        total_score=total,
        objective_bound=round(solver.BestObjectiveBound()),
        solver_runtime_s=elapsed,
        objective_value=round(solver.ObjectiveValue()),
        kept_slots=kept,
    )
