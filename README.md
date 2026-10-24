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

Open the planner at https://chrishoangle.github.io/rotation-optimizer/app/.
The example in the planner, and in the tour, is the real STEW 2026 family
dinner, seated as it ran: the alumni by name and what they do, with no
contact details. New to it? **Take the 2-minute tour** on the first screen: seven short scenes
walk through a whole dinner, from the two lists to next year's file. With an
event open, the tour uses a copy of your own alumni and fams (it never changes
your event); otherwise it uses the STEW 2026 dinner.
It is organised around what a coordinator does, in four places: **Set up**
(before any names, two numbers, tables and alumni, show the rotation playing
out, every alum one table on each round so nobody visits a table twice; then
paste what you already have from Google Docs, Sheets, or Excel: last year's
seating chart, with a column per round, gives the fams, the alumni and pairs,
and the seating itself, and an alumni list of names, emails, and what each
alum does adds their interests, with the emails dropped; or paste your alumni
and fams as plain lists; a title row is skipped and said so; alumni who
share a field host one table together as a pair, and any pair can be split or
two alumni paired by hand), **Schedule** (the room drawn one round at a time,
drawn as soon as both lists are in, with each alum or pair at their table and the interest they share on the tables that have one, a line saying how many conversations share an interest when that is the best these lists allow, and Watch the night to play the rounds in turn; in Adjust you tap two tables on the room itself to swap them), **Print** (what to print, how many pages, and why, then Print
everything; after a change, only the pages that changed), and **Run** (a
separate full-screen mode for a phone: the round, the clock, one button, and
"Something came up", which turns any change into a list of people to tell,
with who is where always beside it; on a laptop the two sit side by side;
if one of a pair leaves, their partner keeps the table and nobody moves).
After the last round, **Wrap up** saves the event for next year. Wherever you
are, the logo goes home (the dinner, its progress, and one Next button), the
tabs say where you are, a bar at the bottom holds Back and the next action, and
anything removed or replaced can be undone for a few seconds; on a phone the
next action floats above the tabs and Back sits in the header. The paste box
reads whatever is pasted, and can show real example rows for the three things
coordinators paste (a seating chart, an alumni list, one per line); fams typed
one per line have their majors cleaned up the same way as from a chart; alumni typed one per line also get close interests (medicine also matches biology and pre-med), said in the note and editable; one timeline (doors, when round 1 starts, round length, changeover, an open floor at the end) sets the run sheet and the night, and the STEW 2026 example carries the night as it ran (round 1 at 6:16 PM, 12-minute rounds, 3-minute changeovers, open networking until 6:58 PM); and **Send to your phone** carries the
dinner to your phone in a link, without student names. Special
arrangements (late arrivals, stairs, must or never meet) sit under More
options; file actions and the extra night tools (check-in, room setup, QR
code) sit in the ⋯ menu. Every option below is also in the full planner, at
the address ending in `#full`. No install and no
code are needed, and nothing leaves the browser: the solver runs in the page
(HiGHS compiled to WebAssembly), and the event is saved on that computer as
you work. The same app also runs in Python with Streamlit at
https://rotation-optimizer.streamlit.app; event files work in both.
The practice dinner, in `templates/practice_hosts.csv` and
`templates/practice_fams.csv`, has the same tables as the example below with
tags reworded so hosts and fams use the same words, which is how tags should
be written.

1. Collect sign-ups. The sidebar gives a Google Apps Script that makes two
   Google Forms in your own account, one for alumni and one for students,
   with the same list of fields to tick (`templates/fields.txt`), so their
   answers match exactly and upload with no column matching. Or fill in the
   hosts and fams templates, upload any CSV (you pick which column holds
   what; email and phone columns are always dropped), or paste rows copied
   from a spreadsheet.
2. Add pairing rules if you need them: must meet, never meet, only in
   rounds (an alum who comes late or leaves early), stays with (an alum
   who stays at one fam's table all night), or needs step-free (an alum who
   only visits tables marked step-free).
3. Find the schedule. The page says how many pairings share an interest,
   and Why? next to any pairing explains it and lets you choose a different
   host, which becomes a must meet rule you can undo.
4. Print the seating chart, host cards, table tents, and run sheet, plus a
   backup packet with the whole schedule on paper, a plan summary for a
   director, runner sheets (each runner's tables, split by part of the
   room), and host badges. Fam tables can say where they are in the room
   ("by the stage"), which is printed on host cards, and whether they are
   step-free. Mark as printed also downloads a backup of the event file. The
   sidebar prints a two-page coordinator guide, volunteer role cards, and a
   privacy note.
5. Rehearse with Practice a cancellation first, which runs the night on a copy.
6. On the night, Run works on a phone. The extra night tools in the ⋯ menu add:
   - Room setup: put the tents out, walk the room with the setup sheet, and
     tick each table. If a fam is already sitting at another table, record
     the number they are at instead of moving the students.
   - Check-in for alumni (with Didn't show and Arrived late) and a count of
     students per fam.
   - Start and finish each round on a clock: time left, how late the night
     is running, when it will end, and an MC cue card with new times.
     Between rounds, tick each alum as they reach their table.
   - Who is where now and next, a search for anyone, cancellations, late
     alumni, and Not right? to keep an alum where they actually sat.
   - Re-plan now keeps finished rounds and the printed schedule wherever it
     can, then says who to send where (with a tick when each person is
     told), prints change slips, and lists exactly which pages to reprint.
   - A QR code opens a read-only "who is where" page on any volunteer's
     phone. The schedule travels inside the link after "#", so there is
     still no server, and it never includes student names.
   - At the end it asks what to change next year and adds it to the notes.
7. Hand off to next year downloads a folder with the event file (without
   student names or the night's changes), your notes for next year, and a
   log of what happened on the night.

The page keeps working with no internet after one visit, keeps the last
twelve versions in the browser, and can download a one-file offline copy of
itself.

Tags and interests are keywords separated by commas or semicolons. A tag
only adds to a score when a fam lists the exact same word, so the tool lists
every tag that has no match on the other side and offers one click fixes for
near misses such as pre-med and premed.

Host and fam counts do not need to match. With more fams than hosts, some
fams get an open table for a round. With more hosts than fams, some hosts
have no table for a round. A table hosted by two people is entered as one
host.

The web app lives in [`web/`](web/) and is a TypeScript port of this
package. Its tests check it against output written by the Python package
(`scripts/export_parity_cases.py`): the same best score for each of 51
scheduling cases, the same messages, and the same printouts byte for byte.
To build it into `docs/app/`:

```bash
cd web && npm ci && npm test && npm run build
```

To run the Streamlit app on your own computer:

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
