"""Pairwise host-group match scoring.

Scoring is deliberately separated from the solver. The solver only sees an
integer score matrix; the semantics of "match quality" live here. This means
you can swap in a different scoring function (e.g., sentence embeddings)
without touching the optimization layer.

The default scorer uses weighted tag overlap with a saturation term, which
rewards precise matches without letting a host with many generic tags
dominate every slot.
"""

from __future__ import annotations

from typing import Protocol

from .models import GuestGroup, Host


class Scorer(Protocol):
    """Any callable that scores a (host, group) pair returning a non-negative int.

    Integer-valued because OR-Tools' CP-SAT solver works on integers; using
    floats would require a scaling step with no accuracy benefit here.
    """

    def __call__(self, host: Host, group: GuestGroup) -> int: ...


def tag_overlap_score(host: Host, group: GuestGroup, *, scale: int = 100) -> int:
    """Default scorer: scaled Jaccard-like overlap with a precision bonus.

    The raw signal is |host.tags ∩ group.interests|. To normalize across
    hosts with different tag-set sizes, we divide by |host.tags ∪ group.interests|
    (classic Jaccard), then scale to an integer so the solver can work with it.

    An empty intersection returns 0, not an error — unrelated host/group pairs
    are legal in the schedule, they just contribute nothing to the objective.
    """
    if not host.tags or not group.interests:
        return 0

    intersection = host.tags & group.interests
    union = host.tags | group.interests
    if not union:
        return 0

    jaccard = len(intersection) / len(union)
    return int(round(jaccard * scale))


def build_score_matrix(
    hosts: list[Host],
    groups: list[GuestGroup],
    *,
    scorer: Scorer = tag_overlap_score,
) -> dict[tuple[str, str], int]:
    """Precompute scores for every (host, group) pair.

    Returned as a dict rather than a list-of-lists so the solver can index by
    stable string ids rather than list position — safer when hosts or groups
    get added/removed between runs.
    """
    return {
        (h.host_id, g.group_id): scorer(h, g)
        for h in hosts
        for g in groups
    }
