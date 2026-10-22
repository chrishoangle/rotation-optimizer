"""Data models for the rotation optimizer.

A rotation problem has three ingredients:
  - Hosts: the people who move between tables each round (e.g., alumni).
  - Guest groups: the stationary tables (e.g., fams of admits).
  - Rounds: how many times hosts rotate.

The solver's job: assign exactly one host to each (guest_group, round) slot,
maximizing total match quality under the no-repeat-pairing constraint.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable


@dataclass(frozen=True)
class Host:
    """A rotating host (e.g., an alum or pair of alums at one themed table).

    `tags` is a free-form set of lowercase keywords describing what the host
    offers conversationally. The scoring layer compares these against guest
    group interest tags.
    """

    host_id: str
    name: str
    theme: str
    tags: frozenset[str]

    @classmethod
    def make(cls, host_id: str, name: str, theme: str, tags: Iterable[str]) -> "Host":
        return cls(
            host_id=host_id,
            name=name,
            theme=theme,
            tags=frozenset(t.strip().lower() for t in tags if t.strip()),
        )


@dataclass(frozen=True)
class GuestGroup:
    """A stationary group of guests at a single table (e.g., a fam of admits).

    `interests` carries the collective interest tags across the group's members.
    The scoring layer uses these to compute compatibility with each host.
    """

    group_id: str
    name: str
    interests: frozenset[str]
    size: int = 0

    @classmethod
    def make(
        cls,
        group_id: str,
        name: str,
        interests: Iterable[str],
        size: int = 0,
    ) -> "GuestGroup":
        return cls(
            group_id=group_id,
            name=name,
            interests=frozenset(i.strip().lower() for i in interests if i.strip()),
            size=size,
        )


@dataclass(frozen=True)
class Assignment:
    """One host at one guest group's table in one round."""

    round_number: int
    host_id: str
    group_id: str
    score: int


@dataclass
class Schedule:
    """The solver's output: every (round, group) slot filled by one host.

    Invariants (enforced by the solver, verified by tests):
      - Every (round, group) pair appears exactly once.
      - Within a single round, every host appears at exactly one group.
      - Across all rounds, no (host, group) pair repeats (no fam ever sees
        the same host twice).
    """

    assignments: list[Assignment] = field(default_factory=list)
    total_score: int = 0
    objective_bound: int | None = None  # OR-Tools' proof of optimality
    solver_runtime_s: float = 0.0

    def by_round(self, round_number: int) -> list[Assignment]:
        return sorted(
            (a for a in self.assignments if a.round_number == round_number),
            key=lambda a: a.group_id,
        )

    def by_group(self, group_id: str) -> list[Assignment]:
        return sorted(
            (a for a in self.assignments if a.group_id == group_id),
            key=lambda a: a.round_number,
        )

    def by_host(self, host_id: str) -> list[Assignment]:
        return sorted(
            (a for a in self.assignments if a.host_id == host_id),
            key=lambda a: a.round_number,
        )

    def per_group_scores(self) -> dict[str, int]:
        """Total score each guest group accumulates across all rounds.

        Useful for fairness diagnostics: a schedule can be optimal in total
        while leaving one group with two weak matches. This surfaces that.
        """
        out: dict[str, int] = {}
        for a in self.assignments:
            out[a.group_id] = out.get(a.group_id, 0) + a.score
        return out
