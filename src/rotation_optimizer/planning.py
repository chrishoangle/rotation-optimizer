"""Plan a real event: uneven table counts, vocabulary checks, and a report.

solve() needs as many hosts as guest groups. Real events rarely line up.
plan_event() pads the shorter side with placeholders that score 0:

  - More fams than hosts: "Open table" placeholders. A fam paired with one
    has no host that round, which the report calls a free round.
  - More hosts than fams: "Break" placeholders. A host paired with one sits
    out that round.

The padded problem goes to solve() unchanged, so C1, C2, and C3 still hold
for every real host and fam. Placeholders are removed from the result.

Placeholders are distinct from each other, so the solver does not stop a
fam from getting two free rounds. The report counts free rounds per fam and
warns when any fam gets more than one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Assignment, GuestGroup, Host
from .scoring import build_score_matrix
from .solver import InfeasibleProblemError, solve

OPEN_PREFIX = "__open_"
BREAK_PREFIX = "__break_"


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

    @property
    def proven_optimal(self) -> bool:
        return self.total_score == self.objective_bound

    def zero_slots(self) -> list[Assignment]:
        return [a for a in self.assignments if a.score == 0]


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


def plan_event(
    hosts: list[Host],
    fams: list[GuestGroup],
    rounds: int,
    *,
    time_limit_s: float = 30.0,
    num_workers: int | None = None,
) -> EventPlan:
    """Pad, solve, and strip placeholders.

    Uses OR-Tools' default parallel search, which proves optimality much
    faster than a single worker on harder instances. When an event has
    several equally good schedules, which one is returned can change between
    runs. Pass num_workers=1 for a repeatable schedule, at the cost of
    slower proofs.
    """
    if not hosts or not fams:
        raise InfeasibleProblemError("need at least one host and one fam")
    padded_hosts = list(hosts)
    padded_fams = list(fams)
    for i in range(len(fams) - len(hosts)):
        padded_hosts.append(Host.make(f"{OPEN_PREFIX}{i + 1}", "Open table", "Open table", []))
    for i in range(len(hosts) - len(fams)):
        padded_fams.append(GuestGroup.make(f"{BREAK_PREFIX}{i + 1}", "Break", []))

    n = len(padded_hosts)
    if rounds > n:
        raise InfeasibleProblemError(
            f"{rounds} rounds needs at least {rounds} tables on each side; "
            f"this event has {n} after padding, so some fam would meet a host twice"
        )

    schedule = solve(padded_hosts, padded_fams, rounds, time_limit_s=time_limit_s, num_workers=num_workers)

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
        if len(rs) > 1:
            warnings.append(f"{fam_names[fam_id]} has no host in {len(rs)} rounds ({', '.join(map(str, sorted(rs)))}).")
    if schedule.total_score != schedule.objective_bound:
        warnings.append(
            f"The solver stopped at the {time_limit_s:.0f} s limit before proving this is the best schedule. "
            f"Score {schedule.total_score}, best possible at most {schedule.objective_bound}."
        )

    return EventPlan(
        hosts=list(hosts),
        fams=list(fams),
        rounds=rounds,
        assignments=sorted(real, key=lambda a: (a.round_number, a.group_id)),
        free_rounds={k: sorted(v) for k, v in free.items()},
        host_breaks={k: sorted(v) for k, v in breaks.items()},
        total_score=schedule.total_score,
        objective_bound=schedule.objective_bound,
        runtime_s=schedule.solver_runtime_s,
        warnings=warnings,
    )
