"""Solver invariant tests.

These verify that the CP-SAT formulation produces schedules satisfying every
constraint, and that the solution is actually optimal (not just feasible).
Each test is small enough to reason about by hand, so if one fails you can
tell exactly which constraint is wrong.
"""

from __future__ import annotations

import pytest

from rotation_optimizer import (
    GuestGroup,
    Host,
    InfeasibleProblemError,
    solve,
    tag_overlap_score,
)


# ----------------------------------------------------------------------
# Fixtures: tiny problems whose optimum is calculable by hand.
# ----------------------------------------------------------------------


@pytest.fixture
def toy_three() -> tuple[list[Host], list[GuestGroup]]:
    """3 hosts, 3 groups, cleanly aligned on single tags.

    Score matrix (tag_overlap_score, scaled by 100):
                g_sci  g_art  g_biz
        h_sci   100     0      0
        h_art    0    100      0
        h_biz    0      0    100

    Trivially, the diagonal assignment is optimal.
    """
    hosts = [
        Host.make("h_sci", "Scientist", "Science", ["science"]),
        Host.make("h_art", "Artist", "Art", ["art"]),
        Host.make("h_biz", "Entrepreneur", "Business", ["business"]),
    ]
    groups = [
        GuestGroup.make("g_sci", "Science Group", ["science"]),
        GuestGroup.make("g_art", "Art Group", ["art"]),
        GuestGroup.make("g_biz", "Business Group", ["business"]),
    ]
    return hosts, groups


# ----------------------------------------------------------------------
# Invariant tests.
# ----------------------------------------------------------------------


def test_each_round_covers_every_group_exactly_once(toy_three):
    """(C2) Every group has exactly one host each round."""
    hosts, groups = toy_three
    schedule = solve(hosts, groups, rounds=2)
    for r in [1, 2]:
        groups_in_round = [a.group_id for a in schedule.by_round(r)]
        assert sorted(groups_in_round) == sorted(g.group_id for g in groups), (
            f"round {r}: expected every group once, got {groups_in_round}"
        )


def test_each_round_uses_every_host_exactly_once(toy_three):
    """(C1) Every host is assigned to exactly one group each round."""
    hosts, groups = toy_three
    schedule = solve(hosts, groups, rounds=2)
    for r in [1, 2]:
        hosts_in_round = [a.host_id for a in schedule.by_round(r)]
        assert sorted(hosts_in_round) == sorted(h.host_id for h in hosts), (
            f"round {r}: expected every host once, got {hosts_in_round}"
        )


def test_no_host_group_pair_repeats_across_rounds(toy_three):
    """(C3) No fam ever sees the same host twice."""
    hosts, groups = toy_three
    schedule = solve(hosts, groups, rounds=2)
    pairs = [(a.host_id, a.group_id) for a in schedule.assignments]
    assert len(pairs) == len(set(pairs)), (
        f"found repeated (host, group) pair in {pairs}"
    )


def test_perfect_alignment_hits_known_optimum(toy_three):
    """Diagonal assignment scores 100+100+100=300 in round 1.

    In round 2, no-repeat forces off-diagonal pairings, all scoring 0.
    Optimum = 300.
    """
    hosts, groups = toy_three
    schedule = solve(hosts, groups, rounds=2)
    assert schedule.total_score == 300
    assert schedule.objective_bound == 300, (
        "solver should prove optimality (bound == objective) on a problem "
        "this small"
    )


def test_solver_proves_optimality_on_realistic_size():
    """A 6-host, 6-group, 2-round problem should solve to proven optimality.

    This is the smoke test for the real-world scale this project targets.
    """
    hosts = [
        Host.make(f"h{i}", f"Host {i}", f"Theme {i}", [f"tag_{i}", "shared"])
        for i in range(6)
    ]
    groups = [
        GuestGroup.make(f"g{i}", f"Group {i}", [f"tag_{i}", "shared"])
        for i in range(6)
    ]
    schedule = solve(hosts, groups, rounds=2)
    assert schedule.total_score == schedule.objective_bound, (
        "solver did not prove optimality on a 6x6x2 problem: formulation "
        "may be inefficient"
    )


# ----------------------------------------------------------------------
# Error cases.
# ----------------------------------------------------------------------


def test_mismatched_counts_raise():
    hosts = [Host.make("h1", "A", "x", ["x"])]
    groups = [
        GuestGroup.make("g1", "G1", ["x"]),
        GuestGroup.make("g2", "G2", ["x"]),
    ]
    with pytest.raises(InfeasibleProblemError, match="host count"):
        solve(hosts, groups, rounds=1)


def test_too_many_rounds_raise(toy_three):
    """With H hosts, R > H forces a repeat; must be rejected before solving."""
    hosts, groups = toy_three
    with pytest.raises(InfeasibleProblemError, match="exceeds host count"):
        solve(hosts, groups, rounds=4)


def test_empty_inputs_raise():
    with pytest.raises(InfeasibleProblemError, match="non-empty"):
        solve([], [], rounds=1)


# ----------------------------------------------------------------------
# Scoring sanity.
# ----------------------------------------------------------------------


def test_tag_overlap_identical_sets_scores_100():
    h = Host.make("h", "x", "x", ["a", "b"])
    g = GuestGroup.make("g", "x", ["a", "b"])
    assert tag_overlap_score(h, g) == 100


def test_tag_overlap_disjoint_sets_scores_0():
    h = Host.make("h", "x", "x", ["a"])
    g = GuestGroup.make("g", "x", ["z"])
    assert tag_overlap_score(h, g) == 0


def test_tag_overlap_empty_set_scores_0():
    h = Host.make("h", "x", "x", [])
    g = GuestGroup.make("g", "x", ["a"])
    assert tag_overlap_score(h, g) == 0
