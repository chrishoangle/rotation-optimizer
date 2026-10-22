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

from ortools.sat.python import cp_model

from .models import Assignment, GuestGroup, Host, Schedule
from .scoring import Scorer, build_score_matrix, tag_overlap_score


class InfeasibleProblemError(RuntimeError):
    """Raised when the constraints cannot be satisfied (e.g., R > H)."""


def solve(
    hosts: list[Host],
    groups: list[GuestGroup],
    rounds: int,
    *,
    scorer: Scorer = tag_overlap_score,
    time_limit_s: float = 30.0,
    num_workers: int | None = None,
) -> Schedule:
    """Return the optimal (or best-found) rotation schedule.

    Preconditions:
      - len(hosts) == len(groups): one host per table per round
      - rounds <= len(hosts): otherwise C3 (no repeats) is infeasible,
        since each host can visit each group at most once

    Raises InfeasibleProblemError if preconditions fail or the solver
    cannot find any feasible assignment within time_limit_s.

    A problem can have several optimal schedules with the same score. With
    OR-Tools' default parallel search, which one is returned can change from
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
    for h in range(H):
        for g in range(G):
            model.Add(sum(x[h, g, r] for r in range(rounds)) <= 1)

    # Objective: maximize total match score across all assignments.
    model.Maximize(
        sum(
            scores[hosts[h].host_id, groups[g].group_id] * x[h, g, r]
            for h in range(H)
            for g in range(G)
            for r in range(rounds)
        )
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_s
    if num_workers is not None:
        solver.parameters.num_workers = num_workers
    start = time.perf_counter()
    status = solver.Solve(model)
    elapsed = time.perf_counter() - start

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

    return Schedule(
        assignments=assignments,
        total_score=int(solver.ObjectiveValue()),
        objective_bound=int(solver.BestObjectiveBound()),
        solver_runtime_s=elapsed,
    )
