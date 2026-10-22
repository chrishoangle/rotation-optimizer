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

## Coordinator rules

Rules only add constraints. C1 to C3 always hold.

**(R1) Required pair.** Host $h$ and group $g$ meet exactly once within an
allowed set of rounds $A_{h,g}$, which defaults to every round:

$$
\sum_{r \in A_{h,g}} x_{h,g,r} = 1
$$

**(R2) Forbidden pair.** $x_{h,g,r} = 0$ for every round $r$.

**(R3) Fixed slot.** $x_{h,g,r} = 1$ for a given round $r$. Locked rounds
use this.

**(R4) Forbidden slot.** $x_{h,g,r} = 0$ for a given round $r$. A never
rule limited to some rounds, a cancellation, and the non-locked pairings of
a locked round all use this.

**(R5) Staying host.** Host $h$ stays with one group all night, for an alum
who cannot move between tables. With a boolean $y_{h,g}$ for each real
group, $\sum_g y_{h,g} = 1$, $x_{h,g,r} \le y_{h,g}$ in every round, and
$x_{h,g,r} \ge y_{h,g}$ in every round where the slot is not forbidden. C3
is lifted for $h$ only, since it meets the same group every round. A named
group fixes $y_{h,g} = 1$; a blank one lets the solver choose. Note that a
staying host can raise the total score, because a good pairing then counts
in every round. [`tests/test_stays.py`](../tests/test_stays.py) checks the
rule, and the parity fixture includes seven staying-host cases.

### Uneven counts and cancellations

`plan_event()` pads the problem to $N$ hosts and $N$ groups with
placeholders that score 0. An "Open table" host leaves a group without a
host for that round, and a "Break" group gives a host a round off. Let
$a^H_r$ and $a^G_r$ be the number of hosts and groups cancelled in round
$r$. Then

$$
N = \max\left(H + \max_r a^G_r,\; G + \max_r a^H_r\right)
$$

which leaves enough Breaks for every absent host and enough Open tables for
every absent group in every round. A cancelled host or group gets R4 for
each real partner in each round it misses.

#### Spreading the empty rounds

With placeholders, maximizing score alone can pile the empty rounds onto a
few people. A coordinator review found 12 host tables and 10 fams over 2
rounds leaving one alum with no table at all, and 8 host tables and 11 fams
over 3 rounds leaving one fam without a host twice while others always had
one. Neither shows in the score, because placeholders score 0.

For each real host or group $i$, let $A_i$ be the rounds it is there and
$b_i$ the rounds in $A_i$ with no real partner. The planner minimizes

$$
P = \sum_i \sum_{k=1}^{|A_i| - 1} \max(0,\; b_i - k)
$$

which is zero while nobody sits out more than one round, and grows by more
with each extra empty round, so it spreads empty rounds as evenly as the
rules allow. In particular a host table gets at least one fam whenever the
fams have enough places. Each $\max$ is an integer variable $e_{i,k} \ge 0$
with $e_{i,k} \ge b_i - k$. $P$ ranks below kept slots and above score:
kept slots, then even spread, then score, then the tie-break, each weighted
so that it outweighs everything after it. $P$ is only added when there are
placeholders; with $H = G$ and no cancellations every $b_i$ is 0.

When a gap cannot be avoided the plan says so: a host table with no fam in
any round gets a fairness note suggesting two alums share a table, and a fam
with two open tables is told they are already shared out as evenly as
possible. [`tests/test_uneven.py`](../tests/test_uneven.py) checks both
review cases, and the web app's parity tests check that the browser solver
reaches the same $P$ and the same score on every shared case.

Synthetic events (tags from a fixed pattern, see the test file), Python
3.13.16 and OR-Tools 9.15.6755 with 8 workers on a 2 vCPU x86_64 Xeon
2.8 GHz cloud VM, and HiGHS 1.15.3 under Node 22.22.0 on the same VM:

| H | G | R | score before | score after | fewest rounds hosted, after | CP-SAT | HiGHS |
|---|---|---|---|---|---|---|---|
| 12 | 10 | 2 | 617 | 617 | 1 (was 0) | 0.07 s | 0.21 s |
| 8 | 11 | 3 | 533 | 533 | every fam hosted twice (was once) | 0.07 s | 0.11 s |
| 30 | 8 | 5 | 1208 | 1183 | 1 (was 0) | 2.4 s | 0.26 s |
| 25 | 30 | 4 | 2834 | 2834 | every fam hosted 3 times (was 2) | 3.0 s | 0.82 s |
| 40 | 30 | 6 | 5436 | 5236 | 4 (was 1) | 22.7 s | 3.6 s |

All were proven optimal. Before the change, CP-SAT took 0.73 s, 1.96 s and
6.1 s on the three larger cases; the spread penalty slows its proof on this
2 core machine, while the browser solver stays under 4 s.

### Re-planning while keeping the printed schedule

After a cancellation, `replan()` locks the rounds that already happened
(R3 for their slots, R4 for every other real pairing in those rounds) and
re-solves the rest. By default it keeps the previous schedule wherever it
can. Let $P$ be the previous schedule's slots in the remaining rounds and
$W = R \cdot G \cdot \max_{h,g} s_{h,g} + 1$. The objective becomes

$$
\max \; W \sum_{(h,g,r) \in P} x_{h,g,r} \;+\; \sum_{h,g,r} s_{h,g} \, x_{h,g,r}
$$

The match score can never exceed $W - 1$, so one more kept slot always
outweighs any score difference. The solver therefore keeps as many previous
slots as the rules allow, then maximizes score among those schedules.
"Proven optimal" for a re-plan means the bound equals this weighted
objective. `replan(..., from_scratch=True)` drops the first term, for when
nothing has been printed yet.

[`benchmarks/replan_timing.py`](../benchmarks/replan_timing.py) cancels each
of the 10 hosts in turn from round 2 of the STEW example, with round 1
locked. On Python 3.10.12 and OR-Tools 9.15.6755 in a 4 vCPU aarch64 Linux
VM on an Apple Silicon MacBook Pro, all 10 re-plans were proven optimal and
each changed exactly 1 slot: the cancelled host's round 2 fam, which gets
an open table. The median solver runtime was 0.003 s and 0.004 s across two
runs, with a maximum of 0.005 s.
[`tests/test_rules.py::test_replan_changes_minimum_slots`](../tests/test_rules.py)
checks the one-slot result.

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
The sweep uses OR-Tools' default parallel search, which runs one worker per
core. Scores matched across two runs.

On a machine with few cores that default can be slow to prove optimality.
On a 2 vCPU x86_64 Linux container (Python 3.13.16, OR-Tools 9.15.6755), the
default search had not proven the $H = G = 10$, $R = 3$ example optimal at the
30 s limit, while 8 workers proved it in 0.12 s. `solve()` now uses 8 workers
unless `num_workers` is given, so the hosted app, which runs on a small
machine, gets the faster proof. The reported bound at $R = 4$ and $R = 10$ varied between runs,
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
