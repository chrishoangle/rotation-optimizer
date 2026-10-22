# Algorithm

This document specifies the rotation assignment problem formally and
walks through the CP-SAT formulation used by `rotation_optimizer.solver`.

## Problem statement

A networking event has $H$ hosts, $G$ guest groups, and $R$ rounds. In each
round, every guest group has exactly one host visiting its table. Hosts
rotate between rounds; guest groups stay put. No guest group should see the
same host twice. Each host-group pair carries a score $s_{h,g} \in \mathbb{Z}_{\geq 0}$
representing match quality. Find the rotation schedule that maximizes total
score.

For the problem to admit a feasible solution, we require $H = G$ (one host
per group per round) and $R \leq H$ (so that no-repeat is satisfiable).

## Decision variables

$$
x_{h,g,r} \in \{0, 1\} \quad \forall h \in [H], g \in [G], r \in [R]
$$

$x_{h,g,r} = 1$ iff host $h$ is assigned to guest group $g$ in round $r$.

## Constraints

**(C1) Each host appears exactly once per round.**

$$
\sum_{g=1}^{G} x_{h,g,r} = 1 \quad \forall h \in [H], r \in [R]
$$

**(C2) Each guest group is hosted exactly once per round.**

$$
\sum_{h=1}^{H} x_{h,g,r} = 1 \quad \forall g \in [G], r \in [R]
$$

**(C3) No host-group pair repeats across rounds.**

$$
\sum_{r=1}^{R} x_{h,g,r} \leq 1 \quad \forall h \in [H], g \in [G]
$$

## Objective

$$
\max \sum_{h=1}^{H} \sum_{g=1}^{G} \sum_{r=1}^{R} s_{h,g} \cdot x_{h,g,r}
$$

Scores do not depend on the round number. Swapping the order of two whole
rounds therefore gives a schedule with the same total score. Optimal
schedules come in groups that differ only by round order. When comparing
the solver's output with a hand-built schedule, compare the set of pairings
per round, not which round each set landed in.

## Why CP-SAT

Every variable is boolean and every coefficient is an integer, so the model
fits CP-SAT, Google OR-Tools' constraint programming solver, without any
scaling or relaxation. CP-SAT also reports a best objective bound alongside
the solution. When the bound equals the returned score, no better schedule
exists. That equality is how this project defines "optimal."

On the 10x10x2 STEW example, the solver returns a score of 341 with a bound
of 341. The test
[`tests/test_example.py::test_example_proves_optimality`](../tests/test_example.py)
checks this on every run, and
[`test_example_solves_under_one_second`](../tests/test_example.py) checks the
runtime.

An integer programming formulation, for example PuLP with CBC, would also
be valid. This project has not benchmarked one, so it makes no claim about
which solver is faster.

## Complexity and measured runtime

Without the no-repeat constraint, each round is any of $G!$ permutations, so
there are $(G!)^R$ schedules. For $H = G = 10, R = 2$ that is
$(10!)^2 \approx 1.32 \times 10^{13}$. With no-repeat, round 2 must share no
pairing with round 1, which leaves $10! \cdot D_{10}$ schedules, where
$D_{10} = 1{,}334{,}961$ is the number of derangements of 10 items. That is
about $4.84 \times 10^{12}$.

The table below comes from
[`benchmarks/rounds_sweep.py`](../benchmarks/rounds_sweep.py) on the STEW
example with $H = G = 10$, a 10 s time limit, Python 3.10.12, and OR-Tools
9.15.6755, run in a 4 vCPU aarch64 Linux VM on an Apple Silicon MacBook Pro.
The sweep uses OR-Tools' default parallel search. Scores matched across
two runs. The reported bound at $R = 4$ and $R = 10$ varied between runs,
which is expected when the solver stops at the time limit.

| R  | Score | Bound | Proven optimal | Runtime (s) |
|---:|------:|------:|:--------------:|------------:|
| 1  | 193   | 193   | yes            | 0.004       |
| 2  | 341   | 341   | yes            | 0.008       |
| 3  | 442   | 442   | yes            | 0.069       |
| 4  | 497   | 526   | no             | 10.005      |
| 5  | 515   | 567   | no             | 10.074      |
| 10 | 542   | 1093  | no             | 10.004      |

Proven optimality in under one second held for $R \leq 3$. At $R = 4$ and
$R = 5$ the solver stopped at the time limit with a gap between score and
bound. At $R = 10$ every host meets every group exactly once, so every
feasible schedule scores the sum of the whole score matrix, 542. The
solver found that schedule but could not close the bound within 10 s. Why
the gap stays open there has not been investigated.

## Scoring

The scoring function $s_{h,g}$ is deliberately decoupled from the solver.
The default `tag_overlap_score` computes a scaled Jaccard similarity between
a host's career tags and a group's interest tags:

$$
s_{h,g} = \operatorname{round}\left( 100 \cdot \frac{|T_h \cap I_g|}{|T_h \cup I_g|} \right)
$$

where $T_h$ is the host's tag set and $I_g$ is the group's interest set, and
$s_{h,g} = 0$ when either set is empty. The rounding is Python's built-in
`round`, which sends exact halves to the nearest even integer.
This normalizes against hosts with many tags (otherwise a generic host
would dominate every table) while keeping scores integer-valued for the
solver.

Alternative scoring functions (semantic similarity via sentence embeddings,
inverse-document-frequency weighting, categorical hierarchy) can be
plugged in via the `Scorer` protocol without changing the solver.

## Fairness

The default objective maximizes the *sum* of scores. A schedule can be
sum-optimal while leaving one group with two low-scoring matches. The
`Schedule.per_group_scores` method surfaces this, and the STEW example
flags groups scoring below 60% of the median. In the example's optimal
schedule with `num_workers=1`, the Public Affairs & Communications fam
scores 8 in round 1 and 0 in round 2, for a total of 8 against a median of
38. Only one host scores above zero with that fam, so a zero in one of its
two rounds is unavoidable.

Across all fams, a counting argument gives a lower bound on zero-score
slots. A set of fams S needs $R \cdot |S|$ nonzero visits. Host h can
supply at most $\min(R, n_h)$ of them, where $n_h$ is the number of fams in
S that h scores above zero with, because no host visits a fam twice. For
four of the example's fams, demand is 8 and supply is 6, so every feasible
schedule has at least 2 zero-score slots. The solver's schedule has
exactly 2, and the hand schedule used at the event had 3.
[`tests/test_site_data.py::test_min_zero_slots_is_tight`](../tests/test_site_data.py)
confirms the minimum of 2 with CP-SAT.

For stronger fairness guarantees, a max-min objective is possible:

$$
\max \; z \quad \text{s.t.} \quad \sum_{h,r} s_{h,g} \cdot x_{h,g,r} \geq z \quad \forall g
$$

This is implementable as a straightforward CP-SAT extension and is the
natural next feature.
