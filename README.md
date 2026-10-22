# rotation-optimizer

Given a networking event with H hosts, G stationary guest groups, and R
rounds, this tool finds the rotation schedule that maximizes career-interest
alignment under the no-repeat constraint, with proven optimality in under
one second on realistic problem sizes.

## Install

Requires Python 3.10 or newer.

```bash
git clone https://github.com/chrishoangle/rotation-optimizer.git
cd rotation-optimizer
pip install -e ".[test]"
```

The only runtime dependency is `ortools`. The `test` extra adds `pytest`.

## Quickstart

The example models a real alumni networking dinner: 10 career-themed host
tables rotating between 10 stationary fam tables of admitted students,
across 2 rounds. Fams and hosts are described at the group level only.

```bash
python examples/stew_dinner.py
```

The first lines of output:

```
========================================================================
Total match score: 374
Objective bound:   374 (PROVED OPTIMAL)
Solver runtime:    0.009 s
========================================================================
```

`PROVED OPTIMAL` is printed only when the solver's objective bound equals
the score of the schedule it returned. That equality is the proof that no
better schedule exists under the constraints. The script then prints both
rounds and each fam's total score across the night.

Measured on: H = 10, G = 10, R = 2; Python 3.10.12; OR-Tools 9.15.6755;
a 4 vCPU aarch64 Linux VM on an Apple Silicon MacBook Pro. Runtime was
0.009 s in each of 5 runs.

Run the tests:

```bash
python -m pytest tests/ -v
```

## The problem

At a rotating networking dinner, guest groups stay at their tables and
hosts move between rounds. Each group should meet hosts whose careers match
its interests, and no group should meet the same host twice. Building that
schedule by hand means juggling every pairing at once, because a strong
match given away in round 1 is no longer available in round 2. This tool
treats the schedule as a constraint problem. Every round, each host sits at
exactly one table and each table gets exactly one host. Across rounds, no
host and group pair repeats. Within those rules, the solver maximizes the
total match score, where the default score for host h and group g is

```
s(h, g) = round(100 * |T_h ∩ I_g| / |T_h ∪ I_g|)
```

with T_h the host's tag set and I_g the group's interest set, and
s(h, g) = 0 when either set is empty.

## How it works

The formal model, the three constraints, and the reasoning behind using
CP-SAT are in [docs/algorithm.md](docs/algorithm.md).

## The story

The project started from a real event I co-coordinated. The story of that
dinner, and of the rotation decision behind it, is in
[CASE_STUDY.md](CASE_STUDY.md).
