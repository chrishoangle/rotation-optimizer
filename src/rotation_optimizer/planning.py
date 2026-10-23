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
  access      Rule("access", host, ""): the host needs a table with step-free
              access, so never meets a fam whose table is not marked step-free.
  stays       Rule("stays", host, fam): the host stays with one fam all
              night instead of moving, for example an alum who cannot
              move between tables. An empty fam lets the planner choose.
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
NO_HOST = "Open table (no host)"
FAM_ABSENT = "Not attending this round"
BREAK_PREFIX = "__break_"


class RuleConflictError(InfeasibleProblemError):
    """Raised when the coordinator's rules cannot all hold. The message is plain language."""


@dataclass(frozen=True)
class Rule:
    """A coordinator rule. kind is "must", "never", or "stays". Empty rounds means any round; an empty fam on "stays" means any fam."""

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
    host_away: dict[str, list[int]] = field(default_factory=dict)  # cancellations made on the night
    host_limits: dict[str, list[int]] = field(default_factory=dict)  # rounds a host is not hosting, from "only in rounds"
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

    def open_slots(self) -> list[tuple[int, str]]:
        """(round, fam id) for each round a fam that is there has no host."""
        return sorted((r, f) for f, rs in self.free_rounds.items() for r in rs if r not in self.fam_away.get(f, []))

    def weak_count(self) -> int:
        """Pairings that share no tags, plus rounds where a fam has no host."""
        return len(self.zero_slots()) + len(self.open_slots())

    def host_name(self, host_id: str) -> str:
        return next(h.name for h in self.hosts if h.host_id == host_id)

    def host_label(self, host_id: str) -> str:
        """The alum and their topic, "Alum A (Pharmacy)", or just one when they are the same."""
        return host_label(next(h for h in self.hosts if h.host_id == host_id))

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
    host_limits: dict[str, list[int]] | None = None,
) -> None:
    """Find conflicts a coordinator can fix, and explain each one in plain words."""
    hname = {h.host_id: h.name for h in hosts}
    fname = {f.group_id: f.name for f in fams}
    all_rounds = set(range(1, rounds + 1))
    problems: list[str] = []
    host_limits = host_limits or {}

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
        if rule.kind not in ("must", "never", "stays", "access"):
            problems.append(f"Unknown rule type {rule.kind!r}. Use must, never, stays, or access.")
            continue
        if not known(f"A {rule.kind} rule", rule.host_id, rule.fam_id or None):
            continue
        bad = [r for r in rule.rounds if r not in all_rounds]
        if bad:
            problems.append(
                f"The rule {hname[rule.host_id]} {rule.kind} meet {fname[rule.fam_id]} mentions round {bad[0]}, "
                f"but the event has {rounds} rounds."
            )
    if problems:
        raise RuleConflictError("\n".join(problems))

    stays = [r for r in rules if r.kind == "stays"]
    by_stay_host: dict[str, list[Rule]] = {}
    for st in stays:
        by_stay_host.setdefault(st.host_id, []).append(st)
    for h, rs in by_stay_host.items():
        if len(rs) > 1:
            problems.append(f"{hname[h]} has more than one stays with rule. Keep one of them.")
    by_stay_fam: dict[str, list[str]] = {}
    for st in stays:
        if st.fam_id:
            by_stay_fam.setdefault(st.fam_id, []).append(st.host_id)
    for f, hs in by_stay_fam.items():
        if len(hs) > 1:
            problems.append(
                f"{' and '.join(hname[h] for h in hs)} both stay with {fname[f]}, but a fam gets only one host "
                "per round. Choose a different fam for one of them, or leave its fam blank."
            )
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
        limited = set(host_limits.get(m.host_id, []))
        open_rounds = allowed - set(host_away.get(m.host_id, [])) - limited - set(fam_away.get(m.fam_id, []))
        if not open_rounds:
            who = []
            if allowed & limited:
                present = sorted(all_rounds - limited)
                who.append(f"{h} only comes for {_round_text(present)} (pairing rule)")
            if allowed & set(host_away.get(m.host_id, [])):
                who.append(f"{h} is cancelled from {_round_text(allowed & set(host_away[m.host_id]))}")
            if allowed & set(fam_away.get(m.fam_id, [])):
                who.append(f"{f} is cancelled from {_round_text(allowed & set(fam_away[m.fam_id]))}")
            fix = (". Change one of the two rules." if allowed & limited and not (allowed & set(host_away.get(m.host_id, [])))
                   else ". Remove that rule, or change its rounds, then re-plan.")
            problems.append(f"The rule {label} cannot hold because " + " and ".join(who) + fix)
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
    host_limits: Mapping[str, Iterable[int]] | None = None,
    weak_limit: int | None = None,
    step_free_fams: Iterable[str] | None = None,
    _diagnose: bool = True,
) -> EventPlan:
    """Pad, solve, and strip placeholders.

    keep lists (round, host, fam) slots to preserve where possible; it is
    what replan() passes when the previous schedule is already printed.

    host_limits lists rounds a host is not hosting because of an "only in
    rounds" rule. It works like host_away for planning, but is worded as
    availability, never as a cancellation.

    weak_limit, when set, allows each fam at most that many rounds with a
    host who scores 0 with it or an open table.

    step_free_fams lists fams whose table has step-free access; a host with
    an "access" rule never meets any other fam.

    When host tables and fams are uneven, empty rounds are spread evenly
    before score is maximized: every host table gets a fam when there is
    room, and no fam waits twice for a host while another never does (see
    "Spreading the empty rounds" in docs/algorithm.md).

    When scores tie, a real host at a real fam is preferred over an open
    table or a break, so no available host sits out while a fam has no host.

    Uses a parallel search with 8 workers (see solver.DEFAULT_WORKERS). When several schedules are
    equally good, which one is returned can change between runs. Pass
    num_workers=1 for a repeatable schedule, at the cost of slower proofs.
    """
    if not hosts or not fams:
        raise InfeasibleProblemError("need at least one host and one fam")
    if rounds < 1:
        raise InfeasibleProblemError(f"rounds must be at least 1, got {rounds}")
    rules = list(rules)
    host_away = {h: sorted(set(rs)) for h, rs in (host_away or {}).items() if rs}
    host_limits = {h: sorted(set(rs)) for h, rs in (host_limits or {}).items() if rs}
    fam_away = {f: sorted(set(rs)) for f, rs in (fam_away or {}).items() if rs}
    locked = sorted(set(locked))
    _check_rules(hosts, fams, rounds, rules, host_away, fam_away, locked, host_limits)
    cancelled_only = host_away
    host_away = {h: sorted(set(host_away.get(h, [])) | set(host_limits.get(h, []))) for h in set(host_away) | set(host_limits)}

    host_ids = {h.host_id for h in hosts}
    fam_ids = {f.group_id for f in fams}
    for r, h, f in locked:
        if r in host_away.get(h, []) or r in fam_away.get(f, []):
            raise RuleConflictError(
                f"Round {r} already happened with {next(x.name for x in hosts if x.host_id == h)} at "
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
            f"With {len(hosts)} host tables and {len(fams)} fams, the most rounds without any fam "
            f"meeting the same host twice is {n}. Lower the number of rounds to {n} or fewer."
        )
    # A host who needs a step-free table can visit each step-free fam only
    # once, so with fewer such fams than rounds they must sit some rounds
    # out. Each of them may need a Break in any round.
    n += _step_free_breaks(hosts, fams, rounds, rules, host_away, locked, step_free_fams)
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
    reachable = set(step_free_fams or ())
    for a in rules:
        if a.kind == "access" and not reachable & fam_ids:
            raise RuleConflictError(
                f"{next(x.name for x in hosts if x.host_id == a.host_id)} needs a step-free table, but no fam table is "
                "marked as step-free. Mark which fam tables are step-free."
            )
    for a in rules:
        if a.kind == "access":
            # Finished rounds stay as they happened, even if the rule came later.
            done = {r for r, _, _ in locked}
            forbidden_slots.update((r, a.host_id, f) for f in fam_ids - reachable for r in range(1, rounds + 1) if r not in done)
    for n_ in rules:
        if n_.kind == "never" and n_.rounds:
            forbidden_slots.update((r, n_.host_id, n_.fam_id) for r in n_.rounds)

    # With placeholders, spread the empty rounds: no host table sits out
    # every round while there is room, and no fam waits twice for a host
    # while another fam always has one.
    padded = n > min(len(hosts), len(fams))
    every = range(1, rounds + 1)
    spread_hosts = {h: [r for r in every if r not in host_away.get(h, [])] for h in sorted(host_ids)} if padded else None
    spread_groups = {f: [r for r in every if r not in fam_away.get(f, [])] for f in sorted(fam_ids)} if padded else None

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
            prefer_slots=[s for s in keep if s[0] not in {r for r, _, _ in locked} and s[0] <= rounds
                          and s[1] in host_ids and s[2] in fam_ids],
            # Only needed when placeholders exist; with none, every pair is real and
            # the extra term only slows the proof (3 rounds went from 0.05 s to 30 s).
            tiebreak_pairs=[(h, f) for h in host_ids for f in fam_ids] if n > min(len(hosts), len(fams)) else [],
            weak_limit=weak_limit,
            weak_groups=sorted(fam_ids) if weak_limit is not None else (),
            repeat_ok=[h.host_id for h in padded_hosts[len(hosts):]] + [f.group_id for f in padded_fams[len(fams):]],
            spread_hosts=spread_hosts,
            spread_groups=spread_groups,
            stay_hosts={r.host_id: r.fam_id for r in rules if r.kind == "stays"},
            stay_groups=sorted(fam_ids),
        )
    except InfeasibleProblemError as err:
        if "no schedule satisfies every rule" not in str(err):
            raise
        if not _diagnose:
            raise RuleConflictError("No schedule satisfies every rule.") from err
        raise RuleConflictError(
            _explain_conflict(hosts, fams, rounds, rules, cancelled_only, fam_away, locked, host_limits, weak_limit,
                              step_free_fams)
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
    warnings += fairness_warnings(fams, real, rounds, fam_away, {h.host_id: host_label(h) for h in hosts})
    warnings += host_warnings(hosts, real, rounds, host_away)
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
        host_away=cancelled_only,
        host_limits=host_limits,
        fam_away=fam_away,
        locked_rounds=sorted({r for r, _, _ in locked}),
        objective_value=schedule.objective_value,
        kept_slots=schedule.kept_slots,
    )


def _step_free_breaks(hosts, fams, rounds, rules, host_away, locked, step_free_fams) -> int:
    """How many hosts that need a step-free table cannot host every round they are here."""
    reachable = set(step_free_fams or ()) & {f.group_id for f in fams}
    done = {r for r, _, _ in locked}
    short = 0
    for a in {r.host_id for r in rules if r.kind == "access"}:
        met = {f for _, h, f in locked if h == a}
        here = [r for r in range(1, rounds + 1) if r not in done and r not in host_away.get(a, [])]
        if len(here) > len(reachable - met):
            short += 1
    return short


def _explain_conflict(hosts, fams, rounds, rules, host_away, fam_away, locked, host_limits, weak_limit,
                      step_free_fams=None) -> str:
    """Find the few rules, cancellations, or settings that cannot hold together, and name them.

    Starts from everything in force and drops each item in turn; an item
    stays only if the rest can be met without it. What remains is a
    smallest set that conflicts, each item said the way a coordinator set it.
    """
    hname = {h.host_id: h.name for h in hosts}
    fname = {f.group_id: f.name for f in fams}
    all_rounds = set(range(1, rounds + 1))
    items: list[tuple[str, str]] = []  # (kind, key)
    words: dict[tuple[str, str], str] = {}
    for i, rule in enumerate(rules):
        key = ("rule", str(i))
        items.append(key)
        when = f" in {_round_text(rule.rounds)}" if rule.rounds else ""
        if rule.kind == "access":
            words[key] = f"{hname[rule.host_id]} needs a step-free table"
            continue
        if rule.kind == "stays":
            words[key] = f"{hname[rule.host_id]} stays with " + (fname[rule.fam_id] if rule.fam_id else "one fam") + " all night"
            continue
        verb = "must meet" if rule.kind == "must" else "never meets"
        words[key] = f"{hname[rule.host_id]} {verb} {fname[rule.fam_id]}{when}"
    for h, rs in host_limits.items():
        key = ("limit", h)
        items.append(key)
        words[key] = f"{hname[h]} only comes for {_round_text(sorted(all_rounds - set(rs)))}"
    for h, rs in host_away.items():
        key = ("host_away", h)
        items.append(key)
        words[key] = f"{hname[h]} is cancelled from round {min(rs)}"
    for f, rs in fam_away.items():
        key = ("fam_away", f)
        items.append(key)
        words[key] = f"{fname[f]} is cancelled from round {min(rs)}"
    if weak_limit is not None:
        items.append(("weak", ""))
        words[("weak", "")] = "the setting No fam gets more than one weak round"
    if locked:
        items.append(("locked", ""))
        done = sorted({r for r, _, _ in locked})
        words[("locked", "")] = f"{_round_text(done).capitalize()} already happened"

    def feasible(keep: list[tuple[str, str]]) -> bool:
        k = set(keep)
        try:
            plan_event(
                hosts, fams, rounds, time_limit_s=10,
                rules=[r for i, r in enumerate(rules) if ("rule", str(i)) in k],
                host_away={h: rs for h, rs in host_away.items() if ("host_away", h) in k},
                fam_away={f: rs for f, rs in fam_away.items() if ("fam_away", f) in k},
                host_limits={h: rs for h, rs in host_limits.items() if ("limit", h) in k},
                locked=locked if ("locked", "") in k else (),
                weak_limit=weak_limit if ("weak", "") in k else None,
                step_free_fams=step_free_fams,
                _diagnose=False,
            )
            return True
        except (InfeasibleProblemError, RuleConflictError):
            return False

    core = list(items)
    for item in items:
        trial = [x for x in core if x != item]
        if not feasible(trial):
            core = trial
    if not core:
        return "No schedule fits these tables and rounds. Lower the number of rounds, or add host tables or fams."
    named = [words[x] for x in core]
    if len(named) == 1:
        if core == [("weak", "")]:
            return (
                "The setting No fam gets more than one weak round cannot be met with these tables and rounds. "
                "Untick it in the sidebar, or add tags so more hosts share interests with each fam."
            )
        return f"{named[0][0].upper() + named[0][1:]} cannot be met with these tables and rounds. Change it or delete it."
    return ("These cannot all hold at once: " + "; ".join(named) + ". Change a round, or delete one of them.")


def _rounds_words(rounds: list[int]) -> str:
    if len(rounds) == 1:
        return f"round {rounds[0]}"
    return "rounds " + ", ".join(map(str, rounds[:-1])) + f" and {rounds[-1]}"


OPEN_TABLES_SHARED = (
    "There are more fams than host tables, so some fams wait a round without a host. "
    "Add another host table to fix this."
)


def host_label(h: Host) -> str:
    """The alum and their topic, "Alum A (Pharmacy)", or just one when they are the same or there is no alum."""
    return f"{h.person} ({h.name})" if h.person and h.person != h.name else h.name


def host_warnings(
    hosts: list[Host],
    real: list[Assignment],
    rounds: int,
    host_away: Mapping[str, Iterable[int]],
) -> list[str]:
    """Flag host tables that are there for at least one round but never get a fam.

    The planner spreads hosting evenly, so this only happens when the fams
    have fewer places, over all rounds, than there are host tables.
    """
    hosted = {a.host_id for a in real}
    out = []
    for h in hosts:
        there = [r for r in range(1, rounds + 1) if r not in set(host_away.get(h.host_id, []))]
        if there and h.host_id not in hosted:
            out.append(
                f"Fairness check: {host_label(h)} has no table in any round, because there are more host tables "
                "than places at the fams. Seat two alums at one host table, or add a round."
            )
    return out


def fairness_warnings(
    fams: list[GuestGroup],
    real: list[Assignment],
    rounds: int,
    fam_away: Mapping[str, Iterable[int]],
    host_names: Mapping[str, str],
) -> list[str]:
    """Flag fams that spend more than one round with no host or a host who shares none of their interests.

    Rounds the fam is not attending do not count.
    """
    by_slot = {(a.round_number, a.group_id): a for a in real}
    out = []
    for f in fams:
        weak = []
        for r in range(1, rounds + 1):
            if r in set(fam_away.get(f.group_id, [])):
                continue
            a = by_slot.get((r, f.group_id))
            if a is None:
                weak.append(f"round {r}: no host")
            elif a.score == 0:
                weak.append(f"round {r}: {host_names[a.host_id]}, no shared interests")
        if len(weak) > 1:
            out.append(
                f"Fairness check: {f.name} gets no host or a 0-score host in {len(weak)} rounds ("
                + "; ".join(weak) + "). " + (OPEN_TABLES_SHARED if all(w.endswith("no host") for w in weak)
                                             else "Consider a must meet rule for this fam.")
            )
    totals = {f.group_id: sum(a.score for a in real if a.group_id == f.group_id) for f in fams}
    ordered = sorted(totals.values())
    median = ordered[len(ordered) // 2] if ordered else 0
    flagged = {line.split(" gets ")[0].removeprefix("Fairness check: ") for line in out}
    for f in fams:
        if f.name in flagged or median == 0:
            continue
        if totals[f.group_id] < 0.4 * median:
            hosted = {a.round_number for a in real if a.group_id == f.group_id}
            away = set(fam_away.get(f.group_id, []))
            empty = [r for r in range(1, rounds + 1) if r not in hosted and r not in away]
            why = (" It had no host in " + _rounds_words(empty) + "." if empty else "")
            out.append(
                f"Fairness check: {f.name} scores {totals[f.group_id]} in total, far below the typical fam "
                f"({median}).{why} Consider a must meet rule for this fam, or turn on "
                "\"No fam gets more than one weak round\"."
            )
    return out


def replan(
    plan: EventPlan,
    done_rounds: int,
    *,
    cancel_hosts: Mapping[str, int] | None = None,
    cancel_fams: Mapping[str, int] | None = None,
    rules: Iterable[Rule] | None = None,
    baseline: EventPlan | None = None,
    hosts: list[Host] | None = None,
    fams: list[GuestGroup] | None = None,
    from_scratch: bool = False,
    time_limit_s: float = 30.0,
    num_workers: int | None = None,
) -> EventPlan:
    """Keep rounds 1 to done_rounds exactly as they were and re-solve the rest.

    cancel_hosts and cancel_fams map an id to the first round it misses; the
    cancellation covers that round and every later one, and is added to the
    plan's existing cancellations. rules default to the plan's rules.

    By default the remaining rounds keep the baseline schedule wherever the
    changes allow, then maximize score. The baseline is the printed plan when
    given, otherwise `plan`. from_scratch=True maximizes score only, for when
    nothing has been printed yet.

    hosts and fams replace the plan's lists, for example to add a host who
    arrives late or fix a tag. Ids must stay the same for anyone already in
    a finished round.
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
    keep = [] if from_scratch else [s for s in (baseline or plan).slots() if s[0] > done_rounds]
    return plan_event(
        plan.hosts if hosts is None else hosts,
        plan.fams if fams is None else fams,
        plan.rounds,
        time_limit_s=time_limit_s,
        num_workers=num_workers,
        rules=plan.rules if rules is None else rules,
        host_away={h: sorted(rs) for h, rs in host_away.items()},
        host_limits=plan.host_limits,
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


def slot_text(plan: EventPlan, round_number: int, fam_id: str) -> str:
    """What sits at a fam's table in a round, in the words every printout uses."""
    for a in plan.assignments:
        if a.round_number == round_number and a.group_id == fam_id:
            return plan.host_name(a.host_id)
    if round_number in plan.fam_away.get(fam_id, []):
        return FAM_ABSENT
    return NO_HOST


@dataclass(frozen=True)
class Reprint:
    """What to print again after a re-plan, compared with the printed baseline."""

    host_ids: list[str]
    fam_ids: list[str]
    seating_chart: bool
    seating_rounds: list[int] = field(default_factory=list)  # round pages of the seating chart that changed
    finder_page: bool = False  # the find-your-table page changed

    def describe(self, plan: "EventPlan") -> list[str]:
        """Each thing to reprint, in the words a coordinator uses."""
        out = [f"host card for {plan.host_label(h)}" for h in self.host_ids]
        out += [f"table tent for {plan.fam_name(f)}" for f in self.fam_ids]
        pages = [f"round {r} page" for r in self.seating_rounds] + (["find-your-table page"] if self.finder_page else [])
        if pages:
            out.append("seating chart, " + " and ".join(pages))
        return out


def _card(plan: EventPlan, host_id: str) -> dict[int, tuple]:
    host = next((h for h in plan.hosts if h.host_id == host_id), None)
    head = (host.name, host.person) if host else (None, None)
    out = {}
    for r in range(1, plan.rounds + 1):
        a = next((x for x in plan.assignments if x.host_id == host_id and x.round_number == r), None)
        if a is None:
            out[r] = head + (None,)
        else:
            f = next(x for x in plan.fams if x.group_id == a.group_id)
            out[r] = head + (f.table_number, f.name, f.interests)
    return out


def reprint_list(printed: EventPlan, new: EventPlan) -> Reprint:
    """Host cards, table tents, and whether the seating chart need reprinting.

    A host card changes when anything printed on it changes. Cards for hosts
    who are cancelled in every round where their card changed are skipped,
    because they are not coming. A table tent shows only the table number
    and fam name. The seating chart changes when any table's host, number,
    or name changes.
    """
    host_ids = sorted({h.host_id for h in printed.hosts} | {h.host_id for h in new.hosts})
    reprint_hosts = []
    for h in host_ids:
        before, after = _card(printed, h), _card(new, h)
        changed = [r for r in range(1, max(printed.rounds, new.rounds) + 1) if before.get(r) != after.get(r)]
        present = [r for r in changed if r not in new.host_away.get(h, []) or r > new.rounds]
        if present and any(x.host_id == h for x in new.hosts):
            reprint_hosts.append(h)
    old_tents = {f.group_id: (f.name, f.table_number) for f in printed.fams}
    tents = [f.group_id for f in new.fams if old_tents.get(f.group_id) != (f.name, f.table_number)]
    rounds = {c.round_number for c in plan_changes(printed, new)}

    def notes(plan, r):
        return (sorted(h for h, rs in plan.host_away.items() if r in rs),
                sorted(h for h, rs in plan.host_limits.items() if r in rs),
                sorted(h for h, rs in plan.host_breaks.items() if r in rs))

    for r in range(1, new.rounds + 1):
        if notes(printed, r) != notes(new, r):
            rounds.add(r)
    if tents or printed.rounds != new.rounds or {h.host_id: h.name for h in printed.hosts} != {h.host_id: h.name for h in new.hosts}:
        rounds |= set(range(1, new.rounds + 1))
    old_members = {f.group_id: (f.name, f.table_number, f.members) for f in printed.fams}
    finder = any(old_members.get(f.group_id) != (f.name, f.table_number, f.members) for f in new.fams if f.members)
    seating_rounds = sorted(rounds)
    return Reprint(reprint_hosts, tents, bool(seating_rounds or finder), seating_rounds, finder)
