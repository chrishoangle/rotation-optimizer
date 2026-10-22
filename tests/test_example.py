"""Optimality and invariant tests on the committed STEW example.

The README claims proven optimality in under one second on a realistic
problem size. The existing suite proves optimality on 3x3x2 and 6x6x2
problems only. This file runs the solver on the 10x10x2 example in
examples/stew_dinner.py, so the claim rests on the same inputs the README
quotes.
"""

from __future__ import annotations

import importlib.util
from collections import Counter
from pathlib import Path

import pytest

from rotation_optimizer import Schedule, solve

EXAMPLE_PATH = Path(__file__).resolve().parents[1] / "examples" / "stew_dinner.py"
ROUNDS = 2


def _load_example():
    """Import examples/stew_dinner.py by path, since examples/ is not a package."""
    spec = importlib.util.spec_from_file_location("stew_dinner", EXAMPLE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def example():
    return _load_example()


@pytest.fixture(scope="module")
def schedule(example) -> Schedule:
    return solve(example.HOSTS, example.FAMS, rounds=ROUNDS)


def test_example_is_10x10(example):
    """The README describes a 10 host, 10 fam problem. Guard that the example still is one."""
    assert len(example.HOSTS) == 10
    assert len(example.FAMS) == 10


def test_example_proves_optimality(schedule):
    """Optimal means the objective bound equals the returned score, per CLAUDE.md."""
    assert schedule.objective_bound == schedule.total_score


def test_example_matches_readme_score(schedule):
    """The README quotes a total score of 374. If this fails, update the README in the same commit."""
    assert schedule.total_score == 374


def test_example_solves_under_one_second(schedule):
    """The README sentence promises under one second.

    The measured runtime is about 0.009 s, so the one second threshold leaves
    a wide margin for slower CI machines.
    """
    assert schedule.solver_runtime_s < 1.0


def test_example_c1_each_host_once_per_round(schedule, example):
    """(C1) Every host appears exactly once in every round."""
    host_ids = sorted(h.host_id for h in example.HOSTS)
    for r in range(1, ROUNDS + 1):
        assert sorted(a.host_id for a in schedule.by_round(r)) == host_ids


def test_example_c2_each_fam_once_per_round(schedule, example):
    """(C2) Every fam is hosted exactly once in every round."""
    fam_ids = sorted(f.group_id for f in example.FAMS)
    for r in range(1, ROUNDS + 1):
        assert sorted(a.group_id for a in schedule.by_round(r)) == fam_ids


def test_example_c3_no_pair_repeats(schedule):
    """(C3) No (host, fam) pair appears in more than one round."""
    pairs = Counter((a.host_id, a.group_id) for a in schedule.assignments)
    repeats = {p: n for p, n in pairs.items() if n > 1}
    assert not repeats, f"repeated pairs: {repeats}"


def test_example_assignment_count(schedule):
    """Exactly G slots per round are filled: 10 fams times 2 rounds."""
    assert len(schedule.assignments) == 10 * ROUNDS
