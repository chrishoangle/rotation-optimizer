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

Open the app at https://rotation-optimizer.streamlit.app. It starts with the
example dinner and a seven step guide. No install and no code are needed.

1. Enter host tables and fams in the page, or fill in the hosts and fams
   templates (download them from the sidebar) and upload them as CSV. A
   Google Forms export also works: you pick which column holds what, and
   columns you do not pick, such as email, are dropped. Fams can be one row
   per fam or one row per student.
2. Add pairing rules if you need them: must meet, never meet, or a host who
   comes only for some rounds.
3. Find the schedule, then print the seating chart, host cards, table tents,
   and run sheet (an MC timeline and check-in lists). The Before the night
   checklist says what is left.
4. Save the event file. The page keeps nothing after you close it.
5. On the night, mark the rounds that already happened, cancel a host or
   fam, and re-plan. Finished rounds never change, the re-plan keeps the
   printed schedule wherever it can, and the app lists exactly which pages
   to reprint.
6. Hand off to next year downloads a copy without student names or the
   night's changes.

Tags and interests are keywords separated by commas or semicolons. A tag
only adds to a score when a fam lists the exact same word, so the tool lists
every tag that has no match on the other side and offers one click fixes for
near misses such as pre-med and premed.

Host and fam counts do not need to match. With more fams than hosts, some
fams get an open table for a round. With more hosts than fams, some hosts
have no table for a round. A table hosted by two people is entered as one
host.

To run the app on your own computer:

```bash
pip install -e ".[app]"
streamlit run app/streamlit_app.py
```

From the command line, with the example in
[`templates/hosts.csv`](templates/hosts.csv) and
[`templates/fams.csv`](templates/fams.csv):

```bash
rotation-optimizer --hosts templates/hosts.csv --fams templates/fams.csv \
  --rounds 2 --out-csv schedule.csv --out-html seating_chart.html
```

The command line tool does not take rules or cancellations yet.

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
