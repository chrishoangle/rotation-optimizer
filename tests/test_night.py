"""Re-planning on the night with any number of rounds (third review, P1 items 1 to 3)."""

from __future__ import annotations

import copy
import csv
import time
from pathlib import Path

import pytest

from rotation_optimizer import load_fams, load_hosts, reprint_list, solve
from rotation_optimizer.event import EventState, normalize_state, solve_event

ROOT = Path(__file__).resolve().parents[1]


def _example(rounds: int) -> EventState:
    rows = lambda name: list(csv.DictReader((ROOT / "templates" / name).open()))  # noqa: E731
    state = EventState(hosts=rows("hosts.csv"), fams=rows("fams.csv"), rounds=rounds)
    normalize_state(state)
    return state


@pytest.mark.parametrize("rounds", [3, 4, 5])
def test_any_single_cancellation_after_round_1_can_be_replanned(rounds):
    base = _example(rounds)
    solve_event(base)
    base.printed = base.plan
    failures = []
    for kind, ids in [("host", [r["host_id"] for r in base.hosts]), ("fam", [r["fam_id"] for r in base.fams])]:
        for ident in ids:
            state = copy.deepcopy(base)
            state.finished = 1
            (state.cancel_hosts if kind == "host" else state.cancel_fams)[ident] = 2
            try:
                plan = solve_event(state)
            except Exception as err:  # collect every failure, not just the first
                failures.append((kind, ident, str(err)))
                continue
            first = {s for s in plan.slots() if s[0] == 1}
            assert first == {s for s in base.printed.slots() if s[0] == 1}, (kind, ident)
            away = plan.host_away if kind == "host" else plan.fam_away
            assert away[ident] == list(range(2, rounds + 1))
    assert failures == []


def test_cancelled_host_and_fam_together_in_a_three_round_dinner():
    state = _example(3)
    solve_event(state)
    state.printed = state.plan
    state.finished = 1
    state.cancel_hosts = {"h02": 2}
    state.cancel_fams = {"fam_05": 2}
    plan = solve_event(state)
    assert not any(a.host_id == "h02" and a.round_number > 1 for a in plan.assignments)
    assert not any(a.group_id == "fam_05" and a.round_number > 1 for a in plan.assignments)


def test_from_scratch_replan_with_a_cancellation_and_no_finished_round():
    state = _example(3)
    solve_event(state)
    state.printed = state.plan
    state.cancel_fams = {"fam_03": 2}
    solve_event(state, keep_printed=False)


def _small(rule_rounds: str, rounds: int = 3) -> EventState:
    hosts = [("Medicine", "medicine; biology"), ("Law", "law; policy"), ("Tech", "software; data"),
             ("Art", "art; design"), ("Finance", "finance; economics"), ("Teaching", "education; history")]
    fams = ["biology", "law", "data", "design", "economics", "history", "medicine; data", "art; policy"]
    state = EventState(
        hosts=[{"table_label": n, "tags": t} for n, t in hosts],
        fams=[{"fam_label": f"Fam {i}", "interests": t} for i, t in enumerate(fams, start=1)],
        rounds=rounds,
        rules=[{"rule": "only in rounds", "host_table": "Medicine", "fam": "", "rounds": rule_rounds}],
    )
    normalize_state(state)
    return state


@pytest.mark.parametrize("rule_rounds,missed", [("1", [2, 3]), ("1, 2", [3])])
def test_partial_attendance_plans(rule_rounds, missed):
    plan = solve_event(_small(rule_rounds))
    assert plan.host_limits == {"h01": missed}
    assert not any(a.host_id == "h01" and a.round_number in missed for a in plan.assignments)


def test_lowering_rounds_after_printing_replans():
    state = _example(3)
    solve_event(state)
    state.printed = state.plan
    state.rounds = 2
    plan = solve_event(state)  # keeps the printed rounds 1 and 2 where it can
    assert plan.rounds == 2
    assert plan.slots() == {s for s in state.printed.slots() if s[0] <= 2}
    out = reprint_list(state.printed, plan)
    assert len(out.host_ids) == 10 and out.seating_rounds == [1, 2]  # every card listed round 3
    solve_event(state, keep_printed=False)


def test_three_rounds_are_proven_quickly():
    hosts, fams = load_hosts(ROOT / "templates" / "hosts.csv"), load_fams(ROOT / "templates" / "fams.csv")
    start = time.perf_counter()
    schedule = solve(hosts, fams, 3, time_limit_s=20)
    assert schedule.proven_optimal
    assert time.perf_counter() - start < 10


def test_a_conflict_names_the_rules_that_cause_it():
    # With 2 rounds Pharmacy needs two fams, but the rules leave it only Red Fam.
    state = EventState(
        hosts=[{"table_label": n, "tags": "x"} for n in ("Pharmacy", "Law", "Art", "Film")],
        fams=[{"fam_label": n, "interests": "x"} for n in ("Red Fam", "Blue Fam", "Gold Fam", "Teal Fam")],
        rounds=2,
        rules=[
            {"rule": "must meet", "host_table": "Law", "fam": "Red Fam", "rounds": "2"},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Blue Fam", "rounds": ""},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Gold Fam", "rounds": ""},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Teal Fam", "rounds": ""},
            {"rule": "must meet", "host_table": "Art", "fam": "Blue Fam", "rounds": "1"},
        ],
    )
    normalize_state(state)
    with pytest.raises(Exception) as err:
        solve_event(state)
    text = str(err.value)
    assert text == (
        "These cannot all hold at once: Pharmacy never meets Blue Fam; Pharmacy never meets Gold Fam; "
        "Pharmacy never meets Teal Fam. Change a round, or delete one of them."
    )


def test_a_conflict_without_rules_never_mentions_rules():
    state = _small("1")
    state.one_weak_round = True
    state.rules = [{"rule": "only in rounds", "host_table": "Medicine", "fam": "", "rounds": "1"}]
    state.hosts = state.hosts[:2]
    state.fams = [{"fam_label": f"Fam {i}", "interests": "nothing"} for i in range(1, 5)]
    normalize_state(state)
    with pytest.raises(Exception) as err:
        solve_event(state)
    assert "rule(s)" not in str(err.value) and "Try removing pairing rules" not in str(err.value)
