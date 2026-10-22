# CLAUDE.md

Conventions for AI pair-programmers working in this repo. Human maintainer
reads these too.

## One sentence this project serves

Given a networking event where host tables rotate between seated guest
groups, this tool helps a coordinator plan the best-matched rotation under
the no-repeat rule and their own pairing rules, re-plan after a cancellation,
and print everything the night needs.

Optimality and runtime claims live in `docs/algorithm.md`, each with the
problem size it was measured on.

Everything committed to this repo serves that sentence. A section, test, or
feature that does not should be flagged in review.

## Writing style

Prose in this repo follows one voice. Lead with the context frame, then the
observation, then the interpretation, each in its own sentence. Be exact on
what was measured. Be hedged on why.

Punctuation rule: no em dashes or en dashes anywhere in the repo. Not in
prose, not in code comments, not in plot titles, not in commit messages.
Use a comma, a colon, or a new sentence instead. Hyphens inside compound
words are fine.

Docstrings over one line get full sentences and periods. One-liners can
omit the period.

Commit messages: the subject line is imperative mood, under 72 characters.
The body, if present, explains why the change was made, not what the diff
already shows.

## Correctness standards

### Optimality

"Optimal" means `objective_bound == total_score` in the returned Schedule.
It does not mean the solver returned without an error. Any doc claim of
optimality must link to a test that demonstrates it on a representative
problem size.

### Solver invariants

Every Schedule returned by `solve()` satisfies three constraints. Tests
enforce these; do not relax them without an explicit maintainer decision
recorded in a commit.

- C1: each host appears exactly once per round.
- C2: each guest group is hosted exactly once per round.
- C3: no (host, group) pair appears in more than one round.

### Scoring

The scoring function is reported with its exact formula wherever it is
mentioned in docs. Not "a similarity score," the actual expression. The
default scorer is scaled Jaccard overlap, formula in `docs/algorithm.md`.

### Benchmarks

A runtime number without context is useless. Any benchmark reports:

- H, G, R
- Python version
- OR-Tools version
- Hardware (CPU model if local, instance type if cloud)
- Whether the solver proved optimality or stopped at the time limit

### Reproducibility

Any schedule shown in a doc or README is reproducible by running the
example script. If the example changes, update the doc in the same commit.

## Privacy

This project was built around a real alumni networking dinner. The repo
is public and the maintainer is using it in a job search. The privacy
rule is written to make the project feel real without exposing anyone.

### What stays out of the public repo

- Names of individual alumni or admits.
- Email addresses, phone numbers, LinkedIn URLs.
- Current employers, job titles, or school affiliations tied to a named
  individual.
- Photos of a specific person paired with their name, role, or data
  about them.
- Any description specific enough that a stranger could match it to one
  person via a 30-second Google search. If a one-sentence description
  reveals a person, blur it one layer further.

### What is fine in the public repo

- Fam-level interest profiles ("seven admits across engineering disciplines
  with two leaning pre-med"). The unit is the group, not the individual.
- Host theme labels and tag families ("Pharmacy table: pharmacy, pharmd,
  small-business, healthcare"). No alum names attached.
- Pairing structure described at the theme level ("the Pharmacy table
  featured a mid-career practitioner alongside a current PharmD student").
  Fine as long as the description does not identify who.
- Event documentation photos: the group photo from the night, candid
  photos of the room, pictures of table tents or printed materials.
  These show the event, not individuals as data points.
- The story of coordinating the event, the numbering mismatch, and the
  decision to flip the format. This is the maintainer's work and belongs
  in `CASE_STUDY.md`.

### Where real alumni data lives

On the maintainer's local machine, in a file named `stew-real.json` (or
similar) that is listed in `.gitignore`. The solver can be run against it
locally, and the resulting schedule screenshots are personal mementos,
not repo artifacts.

### Consent for photos

Before any photo of real people is committed to the repo, the maintainer
sends a short note to the alumni asking whether they are comfortable with
the group photo being used in a public portfolio case study. Replies are
saved. If any alum declines or does not reply, the photo is cropped,
blurred, or omitted. This is a courtesy, not a legal requirement, and it
protects the maintainer if the question ever comes up.

Status, October 2026: every alumni host gave verbal consent for the group
photo and the table photos to be used in this public case study. Consent
was given verbally, so there are no written replies to save. Admitted
students who appear in a photo are not covered by this consent.

### What to do if a contribution violates this

Reject the PR, delete the branch, and record the reason in a commit on
`main` explaining the rule. Do not merge "just the harmless parts" of a
privacy-violating contribution; the whole branch goes.

## Hypothesis discipline

Any claim about the solver's behavior is a hypothesis until there is a
test or a benchmark for it. The phrase "always finds the optimum" needs a
test demonstrating it on a non-trivial case. The phrase "scales linearly in
H" needs a benchmark showing it. Promoting a hunch into a doc claim is a
review-blocking error.

Hypotheses that have not yet been tested are fine to discuss in commit
bodies or GitHub issues. They do not belong in README, docstrings, or
`docs/`.

## When the maintainer asks you to just build something

Comply with the request. Then, once per working session, flag what the
request will cost in understanding. Example: if asked to write a tricky
CP-SAT constraint without an explanation, write it, then note that the
maintainer will not be able to defend that constraint in a technical
interview, and offer to walk through it afterward.

Do not refuse. Do not stall. Do not pepper every request with teaching
moments. One flag per session.

## Resume generation

Resume bullets about this project are generated from the repo, not written
freehand. Every number in a bullet is traced to the file that produced it,
and the trace is recorded in a commit or a resume-bullets doc.

Acceptable: "Built a CP-SAT solver that produces proven-optimal rotation
schedules for 10x10x2 problems in under 20 ms" (traced to
`examples/stew_dinner.py` output and
`tests/test_solver.py::test_solver_proves_optimality_on_realistic_size`).

Unacceptable: "Built a scalable optimization system for event scheduling"
(no number, no file, no verifiable claim).

## Dependencies

- Python 3.10+
- `ortools` for the CP-SAT solver
- `pytest` for tests

New dependencies require a justification in the commit body: what problem
they solve, what the alternative was, and why the added surface area is
worth it.

## Workflow

- Branch per feature or doc change.
- Tests pass locally and in CI before merge.
- Commits reference the file or doc section they touch.
- `main` is always deployable (the example script runs, the tests pass).
