"""Plan a real event: uneven counts, coordinator rules, cancellations, re-planning.

solve() needs as many hosts as guest groups. plan_event() pads the shorter
side with placeholders that score 0:

  - "Open table" hosts. A fam paired with one has no host that round.
  - "Break" fams. A host paired with one sits out that round.

The padded problem goes to solve(), so C1, C2, and C3 hold for every real
host and fam. Placeholders are removed from the result.

Coordinator rules, all by id, with rounds numbered from 1:

  must        Rule("must", host, fam, rounds): meet once, within `rounds`
              when given, otherwise in any round.
  never       Rule("never", host, fam, rounds): never meet in `rounds`, or
              never at all when rounds is empty.
  host_away   {host_id: rounds} the host is not there, for example after a
              cancellation "from round 2".
  fam_away    {fam_id: rounds} the fam is not there.
  locked      (round, host, fam) slots that already happened. Every other
              real pairing in a locked round is forbidden, so open tables
              and breaks in that round stay as they were.

Conflicts the coordinator can fix are found before solving and reported in
plain words with table and fam names. Anything else that makes the event
impossible is reported with the list of rule types in use.

replan() locks finished rounds, applies cancellations, and re-solves. By
default it keeps the previous schedule wherever it can (see solver.py for
the exact objective), because cards may already be printed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Mapping

from .models import Assignment, GuestGroup, Host
from .scoring import build_score_matrix
from .solver import InfeasibleProblemError, solve

OPEN_PREFIX = "__open_"
BREAK_PREFIX = "__break_"


class RuleConflictError(InfeasibleProblemError):
    """Raised when the coordinator's rules cannot all hold. The message is plain language."""


@dataclass(frozen=True)
class Rule:
    """A coordinator rule. kind is "must" or "never". Empty rounds means any round."""

    kind: str
    host_id: str
    fam_id: str
    rounds: tuple[int, ...] = ()


@dataclass
class EventPlan:
    """The solved schedule for real hosts and fams, plus what a coordinator should check."""

    hosts: list[Host]
    fams: list[GuestGroup]
    rounds: int
    assignments: list[Assignment]
    free_rounds: dict[str, list[int]]
    host_breaks: dict[str, list[int]]
    total_score: int
    objective_bound: int
    runtime_s: float
    warnings: list[str] = field(default_factory=list)
    rules: list[Rule] = field(default_factory=list)
    host_away: dict[str, list[int]] = field(default_factory=dict)
    fam_away: dict[str, list[int]] = field(default_factory=dict)
    locked_rounds: list[int] = field(default_factory=list)
    objective_value: int | None = None
    kept_slots: int | None = None

    @property
    def proven_optimal(self) -> bool:
        value = self.total_score if self.objective_value is None else self.objective_value
        return self.objective_bound == value

    def zero_slots(self) -> list[Assignment]:
        return [a for a in self.assignments if a.score == 0]

    def host_name(self, host_id: str) -> str:
        return next(h.name for h in self.hosts if h.host_id == host_id)

    def fam_name(self, fam_id: str) -> str:
        return next(f.name for f in self.fams if f.group_id == fam_id)

    def slots(self) -> set[tuple[int, str, str]]:
        return {(a.round_number, a.host_id, a.group_id) for a in self.assignments}


def vocabulary_warnings(hosts: list[Host], fams: list[GuestGroup]) -> list[str]:
    """List tags that cannot contribute to any score, plus fams no host scores above zero with.

    A tag only counts when the same word appears on both sides. Spelling
    differences such as "pre-med" and "premed" are the usual cause.
    """
    host_tags = set().union(*(h.tags for h in hosts)) if hosts else set()
    fam_tags = set().union(*(f.interests for f in fams)) if fams else set()
    out: list[str] = []
    unused_host = sorted(host_tags - fam_tags)
    unused_fam = sorted(fam_tags - host_tags)
    if unused_host:
        out.append("Host tags that no fam lists, so they never add to a score: " + ", ".join(unused_host) + ".")
    if unused_fam:
        out.append("Fam interests that no host lists, so they never add to a score: " + ", ".join(unused_fam) + ".")
    scores = build_score_matrix(hosts, fams)
    for f in fams:
        if all(scores[h.host_id, f.group_id] == 0 for h in hosts):
            out.append(f"No host shares any tag with {f.name}. Every round will score 0 for this fam.")
    return out


def _round_text(rounds: Iterable[int]) -> str:
    rs = sorted(rounds)
    if len(rs) == 1:
        return f"round {rs[0]}"
    return "rounds " + ", ".join(map(str, rs[:-1])) + f" and {rs[-1]}"


def _check_rules(
    hosts: list[Host],
    fams: list[GuestGroup],
    rounds: int,
    rules: list[Rule],
    host_away: dict[str, list[int]],
    fam_away: dict[str, list[int]],
    locked: list[tuple[int, str, str]],
) -> None:
    """Find conflicts a coordinator can fix, and explain each one in plain words."""
    hname = {h.host_id: h.name for h in hosts}
    fname = {f.group_id: f.name for f in fams}
    all_rounds = set(range(1, rounds + 1))
    problems: list[str] = []

    def known(rule_text, h, f):
        ok = True
        if h is not None and h not in hname:
            problems.append(f"{rule_text} names a host table that is not in the hosts sheet ({h}).")
            ok = False
        if f is not None and f not in fname:
            problems.append(f"{rule_text} names a fam that is not in the fams sheet ({f}).")
            ok = False
        return ok

    for h, rs in host_away.items():
        if known("A cancellation", h, None):
            for r in rs:
                if r not in all_rounds:
                    problems.append(f"{hname[h]} is cancelled from round {r}, but the event has {rounds} rounds.")
    for f, rs in fam_away.items():
        if known("A cancellation", None, f):
            for r in rs:
                if r not in all_rounds:
                    problems.append(f"{fname[f]} is cancelled from round {r}, but the event has {rounds} rounds.")

    musts = [r for r in rules if r.kind == "must"]
    nevers = [r for r in rules if r.kind == "never"]
    for rule in rules:
        if rule.kind not in ("must", "never"):
            problems.append(f"Unknown rule type {rule.kind!r}. Use must or never.")
            continue
        if not known(f"A {rule.kind} rule", rule.host_id, rule.fam_id):
            continue
        bad = [r for r in rule.rounds if r not in all_rounds]
        if bad:
            problems.append(
                f"The rule {hname[rule.host_id]} {rule.kind} meet {fname[rule.fam_id]} mentions round {bad[0]}, "
                f"but the event has {rounds} rounds."
            )
    if problems:
        raise RuleConflictError("\n".join(problems))

    for m in musts:
        allowed = set(m.rounds) or all_rounds
        h, f = hname[m.host_id], fname[m.fam_id]
        label = f"{h} must meet {f}" + (f" in {_round_text(m.rounds)}" if m.rounds else "")
        for n in nevers:
            if (n.host_id, n.fam_id) == (m.host_id, m.fam_id):
                blocked = set(n.rounds) or all_rounds
                if allowed <= blocked:
                    problems.append(
                        f"The rule {label} conflicts with the rule {h} never meet {f}"
                        + (f" in {_round_text(n.rounds)}" if n.rounds else "")
                        + ". Remove one of them."
                    )
        open_rounds = allowed - set(host_away.get(m.host_id, [])) - set(fam_away.get(m.fam_id, []))
        if not open_rounds:
            who = []
            if allowed & set(host_away.get(m.host_id, [])):
                who.append(f"{h} is cancelled from {_round_text(allowed & set(host_away[m.host_id]))}")
            if allowed & set(fam_away.get(m.fam_id, [])):
                who.append(f"{f} is cancelled from {_round_text(allowed & set(fam_away[m.fam_id]))}")
            problems.append(
                f"The rule {label} cannot hold because " + " and ".join(who)
                + ". Remove that rule, or change its rounds, then re-plan."
            )
        locked_met = any((r, m.host_id, m.fam_id) in set(locked) for r in allowed)
        locked_rounds = {r for r, _, _ in locked}
        if not locked_met and allowed <= locked_rounds:
            problems.append(
                f"The rule {label} cannot hold because {_round_text(allowed)} already happened without that pairing. "
                "Remove that rule, then re-plan."
            )

    by_host_round: dict[tuple[str, int], list[str]] = {}
    by_fam_round: dict[tuple[str, int], list[str]] = {}
    for m in musts:
        if len(m.rounds) == 1:
            r = m.rounds[0]
            by_host_round.setdefault((m.host_id, r), []).append(m.fam_id)
            by_fam_round.setdefault((m.fam_id, r), []).append(m.host_id)
    for (h, r), fs in by_host_round.items():
        if len(fs) > 1:
            problems.append(
                f"{hname[h]} has must rules with {', '.join(fname[f] for f in fs)} all in round {r}, "
                "but a host can sit at only one table per round. Move one rule to another round."
            )
    for (f, r), hs in by_fam_round.items():
        if len(hs) > 1:
            problems.append(
                f"{fname[f]} has must rules with {', '.join(hname[h] for h in hs)} all in round {r}, "
                "but a fam gets only one host per round. Move one rule to another round."
            )
    if problems:
        raise RuleConflictError("\n".join(problems))


def plan_event(
    hosts: list[Host],
    fams: list[GuestGroup],
    rounds: int,
    *,
    time_limit_s: float = 30.0,
    num_workers: int | None = None,
    rules: Iterable[Rule] = (),
    host_away: Mapping[str, Iterable[int]] | None = None,
    fam_away: Mapping[str, Iterable[int]] | None = None,
    locked: Iterable[tuple[int, str, str]] = (),
    keep: Iterable[tuple[int, str, str]] = (),
) -> EventPlan:
    """Pad, solve, and strip placeholders.

    keep lists (round, host, fam) slots to preserve where possible; it is
    what replan() passes when the previous schedule is already printed.

    Uses OR-Tools' default parallel search. When several schedules are
    equally good, which one is returned can change between runs. Pass
    num_workers=1 for a repeatable schedule, at the cost of slower proofs.
    """
    if not hosts or not fams:
        raise InfeasibleProblemError("need at least one host and one fam")
    if rounds < 1:
        raise InfeasibleProblemError(f"rounds must be at least 1, got {rounds}")
    rules = list(rules)
    host_away = {h: sorted(set(rs)) for h, rs in (host_away or {}).items() if rs}
    fam_away = {f: sorted(set(rs)) for f, rs in (fam_away or {}).items() if rs}
    locked = sorted(set(locked))
    _check_rules(hosts, fams, rounds, rules, host_away, fam_away, locked)

    host_ids = {h.host_id for h in hosts}
    fam_ids = {f.group_id for f in fams}
    for r, h, f in locked:
        if r in host_away.get(h, []) or r in fam_away.get(f, []):
            raise RuleConflictError(
                f"Round {r} is locked with {next(x.name for x in hosts if x.host_id == h)} at "
                f"{next(x.name for x in fams if x.group_id == f)}, but one of them is cancelled from round {r}. "
                "A finished round cannot change."
            )

    # Size the padding so every round works. Each absent host needs a Break,
    # and each absent fam needs an Open table: N >= G + hosts away in round r
    # and N >= H + fams away in round r, for every round r.
    def most_away(away):
        return max((sum(1 for rs in away.values() if r in rs) for r in range(1, rounds + 1)), default=0)

    n = max(len(hosts) + most_away(fam_away), len(fams) + most_away(host_away))
    if rounds > n:
        raise InfeasibleProblemError(
            f"{rounds} rounds needs at least {rounds} tables on each side; "
            f"this event has {n} after padding, so some fam would meet a host twice"
        )
    padded_hosts = list(hosts) + [
        Host.make(f"{OPEN_PREFIX}{i + 1}", "Open table", "Open table", []) for i in range(n - len(hosts))
    ]
    padded_fams = list(fams) + [
        GuestGroup.make(f"{BREAK_PREFIX}{i + 1}", "Break", []) for i in range(n - len(fams))
    ]

    forbidden_slots: set[tuple[int, str, str]] = set()
    for h, rs in host_away.items():
        for r in rs:
            forbidden_slots.update((r, h, f) for f in fam_ids)
    for f, rs in fam_away.items():
        for r in rs:
            forbidden_slots.update((r, h, f) for h in host_ids)
    locked_set = set(locked)
    for r in {r for r, _, _ in locked}:
        forbidden_slots.update((r, h, f) for h in host_ids for f in fam_ids if (r, h, f) not in locked_set)

    required = [(m.host_id, m.fam_id, m.rounds) for m in rules if m.kind == "must"]
    forbidden_pairs = [(n_.host_id, n_.fam_id) for n_ in rules if n_.kind == "never" and not n_.rounds]
    for n_ in rules:
        if n_.kind == "never" and n_.rounds:
            forbidden_slots.update((r, n_.host_id, n_.fam_id) for r in n_.rounds)

    try:
        schedule = solve(
            padded_hosts,
            padded_fams,
            rounds,
            time_limit_s=time_limit_s,
            num_workers=num_workers,
            required_pairs=required,
            forbidden_pairs=forbidden_pairs,
            fixed_slots=locked,
            forbidden_slots=sorted(forbidden_slots),
            prefer_slots=[s for s in keep if s[0] not in {r for r, _, _ in locked}],
        )
    except InfeasibleProblemError as err:
        if "no schedule satisfies every rule" not in str(err):
            raise
        in_use = []
        if rules:
            in_use.append(f"{len(rules)} pairing rule(s)")
        if host_away or fam_away:
            in_use.append("cancellations")
        if locked:
            in_use.append("locked rounds")
        raise RuleConflictError(
            "No schedule can satisfy all of these at once: " + ", ".join(in_use) + ". "
            "Try removing pairing rules one at a time to find the one that conflicts."
        ) from err

    real: list[Assignment] = []
    free: dict[str, list[int]] = {}
    breaks: dict[str, list[int]] = {}
    for a in schedule.assignments:
        open_host = a.host_id.startswith(OPEN_PREFIX)
        break_fam = a.group_id.startswith(BREAK_PREFIX)
        if open_host and not break_fam:
            free.setdefault(a.group_id, []).append(a.round_number)
        elif break_fam and not open_host:
            breaks.setdefault(a.host_id, []).append(a.round_number)
        elif not open_host and not break_fam:
            real.append(a)

    warnings = vocabulary_warnings(hosts, fams)
    fam_names = {f.group_id: f.name for f in fams}
    for fam_id, rs in sorted(free.items()):
        present = [r for r in rs if r not in fam_away.get(fam_id, [])]
        if len(present) > 1:
            warnings.append(f"{fam_names[fam_id]} has no host in {len(present)} rounds ({', '.join(map(str, sorted(present)))}).")
    if not schedule.proven_optimal:
        warnings.append(
            f"The solver stopped at the {time_limit_s:.0f} s limit before proving this is the best schedule."
        )

    return EventPlan(
        hosts=list(hosts),
        fams=list(fams),
        rounds=rounds,
        assignments=sorted(real, key=lambda a: (a.round_number, a.group_id)),
        free_rounds={k: sorted(v) for k, v in free.items()},
        host_breaks={k: sorted(v) for k, v in breaks.items()},
        total_score=sum(a.score for a in real),
        objective_bound=schedule.objective_bound,
        runtime_s=schedule.solver_runtime_s,
        warnings=warnings,
        rules=rules,
        host_away=host_away,
        fam_away=fam_away,
        locked_rounds=sorted({r for r, _, _ in locked}),
        objective_value=schedule.objective_value,
        kept_slots=schedule.kept_slots,
    )


def replan(
    plan: EventPlan,
    done_rounds: int,
    *,
    cancel_hosts: Mapping[str, int] | None = None,
    cancel_fams: Mapping[str, int] | None = None,
    rules: Iterable[Rule] | None = None,
    from_scratch: bool = False,
    time_limit_s: float = 30.0,
    num_workers: int | None = None,
) -> EventPlan:
    """Keep rounds 1 to done_rounds exactly as they were and re-solve the rest.

    cancel_hosts and cancel_fams map an id to the first round it misses; the
    cancellation covers that round and every later one, and is added to the
    plan's existing cancellations. rules default to the plan's rules.

    By default the remaining rounds keep the previous schedule wherever the
    changes allow, then maximize score. from_scratch=True maximizes score
    only, for when nothing has been printed yet.
    """
    if not 0 <= done_rounds < plan.rounds:
        raise InfeasibleProblemError(
            f"done_rounds must be between 0 and {plan.rounds - 1}, got {done_rounds}"
        )
    host_away = {h: set(rs) for h, rs in plan.host_away.items()}
    fam_away = {f: set(rs) for f, rs in plan.fam_away.items()}
    for h, first in (cancel_hosts or {}).items():
        host_away.setdefault(h, set()).update(range(first, plan.rounds + 1))
    for f, first in (cancel_fams or {}).items():
        fam_away.setdefault(f, set()).update(range(first, plan.rounds + 1))
    locked = [(a.round_number, a.host_id, a.group_id) for a in plan.assignments if a.round_number <= done_rounds]
    keep = [] if from_scratch else [s for s in plan.slots() if s[0] > done_rounds]
    return plan_event(
        plan.hosts,
        plan.fams,
        plan.rounds,
        time_limit_s=time_limit_s,
        num_workers=num_workers,
        rules=plan.rules if rules is None else rules,
        host_away={h: sorted(rs) for h, rs in host_away.items()},
        fam_away={f: sorted(rs) for f, rs in fam_away.items()},
        locked=locked,
        keep=keep,
    )


@dataclass(frozen=True)
class SlotChange:
    """One (round, fam) whose host differs between two plans. None means no host."""

    round_number: int
    fam_id: str
    before: str | None
    after: str | None


def plan_changes(old: EventPlan, new: EventPlan) -> list[SlotChange]:
    """Every (round, fam) whose host changed, in round then fam order."""
    def table(plan):
        return {(a.round_number, a.group_id): a.host_id for a in plan.assignments}

    a, b = table(old), table(new)
    out = []
    for r in range(1, new.rounds + 1):
        for f in new.fams:
            key = (r, f.group_id)
            if a.get(key) != b.get(key):
                out.append(SlotChange(r, f.group_id, a.get(key), b.get(key)))
    return out


def reprint_list(old: EventPlan, new: EventPlan) -> tuple[list[str], list[str]]:
    """Host ids whose cards changed, and fam ids whose table tents changed.

    A host card lists where that host goes each round, so it changes when
    any of the host's slots change. A table tent shows only the table number
    and fam name, so re-planning never changes one; the second list is
    empty unless a fam's name or table number changed between the plans.
    """
    hosts = sorted({c.before for c in plan_changes(old, new) if c.before} | {c.after for c in plan_changes(old, new) if c.after})
    old_fams = {f.group_id: (f.name, getattr(f, "table_number", None)) for f in old.fams}
    tents = [f.group_id for f in new.fams if old_fams.get(f.group_id) != (f.name, getattr(f, "table_number", None))]
    return hosts, tents
