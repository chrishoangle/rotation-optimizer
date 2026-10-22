# rotation-optimizer

Given a networking event with H hosts, G stationary guest groups, and R
rounds, this tool finds the rotation schedule that maximizes career-interest
alignment under the no-repeat constraint, with proven optimality in under
one second on realistic problem sizes.

Project page with an interactive schedule builder:
https://chrishoangle.github.io/rotation-optimizer/

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
Total match score: 341
Objective bound:   341 (PROVED OPTIMAL)
Solver runtime:    0.011 s
========================================================================
```

`PROVED OPTIMAL` is printed only when the solver's objective bound equals
the score of the schedule it returned. That equality is the proof that no
better schedule exists under the constraints. The script then prints both
rounds, each fam's total score across the night, and a comparison with the
rotation built by hand for the real event. That hand schedule follows all
three rules and scores 309 with three zero-score slots. The solver's
schedule scores 341 with two, the fewest any schedule can have.

The example solves with `num_workers=1`. The event has several optimal
schedules with the same score, and a single-threaded search returns the
same one on every run, so the printed schedule is reproducible.

Measured on: H = 10, G = 10, R = 2; Python 3.10.12; OR-Tools 9.15.6755;
a 4 vCPU aarch64 Linux VM on an Apple Silicon MacBook Pro. Runtime was
0.011 s in each of 5 runs.

Run the tests:

```bash
python -m pytest tests/ -v
```

## Plan your own event

Fill in two sheets, one row per host table and one row per fam. Start from
[`templates/hosts.csv`](templates/hosts.csv) and
[`templates/fams.csv`](templates/fams.csv), which hold the example dinner.
Tags and interests are keywords separated by semicolons. A tag only adds to
a score when a fam lists the exact same word, so the tool lists every tag
that has no match on the other side.

In the browser, with no code:

```bash
pip install -e ".[app]"
streamlit run app/streamlit_app.py
```

From the command line:

```bash
rotation-optimizer --hosts templates/hosts.csv --fams templates/fams.csv \
  --rounds 2 --out-csv schedule.csv --out-html seating_chart.html
```

The seating chart is a printable page with one section per round.

Host and fam counts do not need to match. With more fams than hosts, some
fams get an open table for a round. With more hosts than fams, some hosts
sit out a round. The tool warns when a fam gets more than one open round,
but does not prevent it. A table hosted by two people is entered as one
host. Requests such as "this fam must meet this host" are not supported
yet.

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
