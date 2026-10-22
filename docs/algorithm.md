# Algorithm

This document specifies the rotation assignment problem formally and
walks through the CP-SAT formulation used by `rotation_optimizer.solver`.

## Problem statement

A networking event has $H$ hosts, $G$ guest groups, and $R$ rounds. In each
round, every guest group has exactly one host visiting its table. Hosts
rotate between rounds; guest groups stay put. No guest group should see the
same host twice. Each host–group pair carries a score $s_{h,g} \in \mathbb{Z}_{\geq 0}$
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

**(C3) No host–group pair repeats across rounds.**

$$
\sum_{r=1}^{R} x_{h,g,r} \leq 1 \quad \forall h \in [H], g \in [G]
$$

## Objective

$$
\max \sum_{h=1}^{H} \sum_{g=1}^{G} \sum_{r=1}^{R} s_{h,g} \cdot x_{h,g,r}
$$

Scores are independent of round number because, under the equal-weight
assumption, moving a pairing from round 1 to round 2 produces an equally
optimal schedule. This means optimal schedules form equivalence classes
under round permutation — a property worth knowing when comparing the
solver's output against a hand-built schedule.

## Why CP-SAT

This problem is a pure assignment problem with:
- integer coefficients
- combinatorial no-repeat constraints
- a sum-of-products objective

CP-SAT (Google OR-Tools' constraint programming solver) is well-suited here
because:

1. **No continuous relaxation needed.** All variables are boolean. CP-SAT's
   lazy clause generation handles boolean variables natively; an ILP solver
   would need to prove integrality through branching.
2. **Native handling of "exactly one" constraints.** `AddExactlyOne` in
   CP-SAT compiles directly to a propagator rather than a pair of
   inequality constraints, giving tighter unit propagation.
3. **Optimality proof is cheap.** For $H = G = 10, R = 2$ the solver returns
   `OPTIMAL` with `BestObjectiveBound == ObjectiveValue` in under 20 ms —
   proof that no better schedule exists.

An ILP formulation (e.g., in PuLP + CBC) would be legal and arrive at the
same solution, but on larger instances CP-SAT's symmetry breaking and
no-good learning scale better.

## Complexity

Search space: $(G!)^R$ permutations in the unconstrained case, reduced by
the no-repeat constraint. For STEW-sized problems ($H = G = 10, R = 2$):

- Unconstrained: $(10!)^2 \approx 1.3 \times 10^{13}$
- CP-SAT runtime: ~20 ms

Empirically, the problem remains tractable to $H = G = 30, R = 4$ in under
a second. Beyond that, LP relaxation bounds and Lagrangian decomposition
would be worth exploring, but they are not needed for the networking-dinner
use case this library targets.

## Scoring

The scoring function $s_{h,g}$ is deliberately decoupled from the solver.
The default `tag_overlap_score` computes a scaled Jaccard similarity between
a host's career tags and a group's interest tags:

$$
s_{h,g} = \left\lfloor 100 \cdot \frac{|T_h \cap I_g|}{|T_h \cup I_g|} \right\rfloor
$$

where $T_h$ is the host's tag set and $I_g$ is the group's interest set.
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
flags groups scoring below 60% of the median.

For stronger fairness guarantees, a max-min objective is possible:

$$
\max \; z \quad \text{s.t.} \quad \sum_{h,r} s_{h,g} \cdot x_{h,g,r} \geq z \quad \forall g
$$

This is implementable as a straightforward CP-SAT extension and is the
natural next feature.
