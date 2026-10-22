"""Tests for coordinator rules, cancellations, and re-planning.

Small cases use a three-table toy whose scores are easy to check by hand:
host A only matches fam X, B only Y, C only Z, each scoring 100. Larger
cases use the 10x10 example from examples/stew_dinner.py.
"""

from __future__ import annotations

import importlib.util
import io
import time
from collections import Counter
from pathlib import Path

import pytest

from rotation_optimizer import (
    GuestGroup,
    Host,
    InfeasibleProblemError,
    Rule,
    RuleConflictError,
    SheetError,
    load_fams,
    load_hosts,
    load_schedule,
    plan_changes,
    plan_event,
    replan,
    reprint_list,
    schedule_csv,
    schedule_rows,
    solve,
)

ROOT = Path(__file__).resolve().parents[1]


def _example():
    spec = importlib.util.spec_from_file_location("stew_dinner", ROOT / "examples" / "stew_dinner.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def ex():
    return _example()


@pytest.fixture
def toy():
    hosts = [Host.make(i, n, n, [t]) for i, n, t in [("A", "Host A", "x"), ("B", "Host B", "y"), ("C", "Host C", "z")]]
    fams = [GuestGroup.make(i, n, [t]) for i, n, t in [("X", "Fam X", "x"), ("Y", "Fam Y", "y"), ("Z", "Fam Z", "z")]]
    return hosts, fams


def check_invariants(plan):
    """C1, C2, C3 on real hosts and fams, allowing open tables, breaks, and cancellations."""
    for r in range(1, plan.rounds + 1):
        rows = [a for a in plan.assignments if a.round_number == r]
        host_counts = Counter(a.host_id for a in rows)
        fam_counts = Counter(a.group_id for a in rows)
        assert not rows or max(host_counts.values()) == 1  # C1
        assert not rows or max(fam_counts.values()) == 1  # C2
        for h in plan.hosts:
            assert (host_counts[h.host_id] == 1) != (r in plan.host_breaks.get(h.host_id, []))
            if r in plan.host_away.get(h.host_id, []):
                assert host_counts[h.host_id] == 0
        for f in plan.fams:
            assert (fam_counts[f.group_id] == 1) != (r in plan.free_rounds.get(f.group_id, []))
            if r in plan.fam_away.get(f.group_id, []):
                assert fam_counts[f.group_id] == 0
    pairs = Counter((a.host_id, a.group_id) for a in plan.assignments)
    assert not pairs or max(pairs.values()) == 1  # C3


# ----------------------------------------------------------------------
# 1 to 5: each rule is honored and C1 to C3 still hold.
# ----------------------------------------------------------------------


def test_required_pair_meets_once(toy):
    hosts, fams = toy
    plan = plan_event(hosts, fams, 2, rules=[Rule("must", "A", "Y")])
    check_invariants(plan)
    assert sum(1 for a in plan.assignments if (a.host_id, a.group_id) == ("A", "Y")) == 1


def test_required_pair_limited_to_round(toy):
    hosts, fams = toy
    plan = plan_event(hosts, fams, 2, rules=[Rule("must", "A", "Y", (2,))])
    check_invariants(plan)
    assert (2, "A", "Y") in plan.slots()


def test_forbidden_pair_never_meets(ex):
    free = plan_event(ex.HOSTS, ex.FAMS, 2)
    a = max(free.assignments, key=lambda a: a.score)
    plan = plan_event(ex.HOSTS, ex.FAMS, 2, rules=[Rule("never", a.host_id, a.group_id)])
    check_invariants(plan)
    assert all((x.host_id, x.group_id) != (a.host_id, a.group_id) for x in plan.assignments)


def test_fixed_slot_is_used(toy):
    hosts, fams = toy
    plan = plan_event(hosts, fams, 2, locked=[(2, "A", "X"), (2, "B", "Y"), (2, "C", "Z")])
    check_invariants(plan)
    assert {(2, "A", "X"), (2, "B", "Y"), (2, "C", "Z")} <= plan.slots()


def test_forbidden_slot_is_unused(toy):
    hosts, fams = toy
    plan = plan_event(hosts, fams, 2, rules=[Rule("never", "A", "X", (1,))])
    check_invariants(plan)
    assert (1, "A", "X") not in plan.slots()
    assert (2, "A", "X") in plan.slots()  # still the best place for that pair


def test_rules_only_lower_the_score(ex):
    free = plan_event(ex.HOSTS, ex.FAMS, 2)
    plan = plan_event(ex.HOSTS, ex.FAMS, 2, rules=[Rule("must", "h04", "fam_01"), Rule("never", "h01", "fam_02")])
    check_invariants(plan)
    assert plan.total_score <= free.total_score
    assert plan.proven_optimal


# ----------------------------------------------------------------------
# 6 to 10: conflicts give plain-language errors with names, not ids.
# ----------------------------------------------------------------------


def test_must_and_never_same_pair(toy):
    hosts, fams = toy
    with pytest.raises(RuleConflictError) as err:
        plan_event(hosts, fams, 2, rules=[Rule("must", "A", "Y"), Rule("never", "A", "Y")])
    assert "Host A must meet Fam Y conflicts with the rule Host A never meet Fam Y" in str(err.value)


def test_locked_slot_with_cancelled_host(toy):
    hosts, fams = toy
    with pytest.raises(RuleConflictError, match="A finished round cannot change"):
        plan_event(hosts, fams, 2, locked=[(1, "A", "X"), (1, "B", "Y"), (1, "C", "Z")], host_away={"A": [1]})


def test_two_musts_for_one_host_in_one_round(toy):
    hosts, fams = toy
    with pytest.raises(RuleConflictError) as err:
        plan_event(hosts, fams, 2, rules=[Rule("must", "A", "X", (1,)), Rule("must", "A", "Y", (1,))])
    msg = str(err.value)
    assert "Host A has must rules with Fam X, Fam Y all in round 1" in msg
    assert "only one table per round" in msg


def test_must_with_host_cancelled_every_round(toy):
    hosts, fams = toy
    with pytest.raises(RuleConflictError, match="Host A is cancelled from rounds 1 and 2"):
        plan_event(hosts, fams, 2, rules=[Rule("must", "A", "Y")], host_away={"A": [1, 2]})


def test_unknown_names_and_rounds(toy):
    hosts, fams = toy
    with pytest.raises(RuleConflictError, match="not in the hosts sheet"):
        plan_event(hosts, fams, 2, rules=[Rule("must", "Q", "X")])
    with pytest.raises(RuleConflictError, match="mentions round 3, but the event has 2 rounds"):
        plan_event(hosts, fams, 2, rules=[Rule("must", "A", "X", (3,))])


def test_other_infeasibility_names_rule_types(toy):
    hosts, fams = toy
    # Each pair below is allowed on its own, but A, B, and C cannot all
    # meet X in two rounds.
    rules = [Rule("must", h, "X") for h in "ABC"]
    with pytest.raises(RuleConflictError, match="No schedule can satisfy all of these at once: 3 pairing rule"):
        plan_event(hosts, fams, 2, rules=rules)


# ----------------------------------------------------------------------
# 11, 12: padding when hosts are away.
# ----------------------------------------------------------------------


def test_away_host_sits_out_and_fam_gets_open_table(ex):
    plan = plan_event(ex.HOSTS, ex.FAMS, 2, host_away={"h03": [2]})
    check_invariants(plan)
    assert len([a for a in plan.assignments if a.round_number == 1]) == 10
    assert len([a for a in plan.assignments if a.round_number == 2]) == 9
    assert sum(1 for rs in plan.free_rounds.values() if 2 in rs) == 1


def test_two_away_with_fewer_hosts_than_fams():
    tags = list("abcdefghij")
    hosts = [Host.make(f"h{i}", f"Host {i}", f"Host {i}", [tags[i], tags[i + 1]]) for i in range(8)]
    fams = [GuestGroup.make(f"f{i}", f"Fam {i}", [tags[i], tags[(i + 2) % 10]]) for i in range(10)]
    plan = plan_event(hosts, fams, 2, host_away={"h0": [2], "h1": [2]})
    check_invariants(plan)
    assert sum(1 for rs in plan.free_rounds.values() if 2 in rs) == 4
    assert sum(1 for rs in plan.free_rounds.values() if 1 in rs) == 2


# ----------------------------------------------------------------------
# 13 to 15, 23 to 26: replan().
# ----------------------------------------------------------------------


def test_replan_cancellation_keeps_round_1(ex):
    first = plan_event(ex.HOSTS, ex.FAMS, 2)
    second = replan(first, done_rounds=1, cancel_hosts={"h03": 2})
    check_invariants(second)
    r1 = lambda p: {s for s in p.slots() if s[0] == 1}
    assert r1(second) == r1(first)
    assert not any(a.host_id == "h03" and a.round_number == 2 for a in second.assignments)
    met_in_round_1 = {(h, f) for _, h, f in r1(first)}
    assert not any((a.host_id, a.group_id) in met_in_round_1 for a in second.assignments if a.round_number == 2)
    assert second.proven_optimal  # optimal under keep-then-score objective


def test_replan_keeps_locked_open_tables_and_breaks():
    tags = list("abcdefghij")
    hosts = [Host.make(f"h{i}", f"Host {i}", f"Host {i}", [tags[i], tags[i + 1]]) for i in range(8)]
    fams = [GuestGroup.make(f"f{i}", f"Fam {i}", [tags[i], tags[(i + 2) % 10]]) for i in range(10)]
    first = plan_event(hosts, fams, 2)
    second = replan(first, done_rounds=1, cancel_hosts={"h5": 2})
    check_invariants(second)
    free_r1 = lambda p: {f for f, rs in p.free_rounds.items() if 1 in rs}
    assert free_r1(second) == free_r1(first)


def test_replan_rejects_bad_done_rounds(ex):
    plan = plan_event(ex.HOSTS, ex.FAMS, 2)
    with pytest.raises(InfeasibleProblemError, match="done_rounds"):
        replan(plan, done_rounds=2)
    with pytest.raises(RuleConflictError, match="finished round cannot change"):
        replan(plan, done_rounds=1, cancel_hosts={"h03": 1})


def test_replan_changes_minimum_slots_toy(toy):
    hosts, fams = toy
    first = plan_event(hosts, fams, 2, num_workers=1)
    gone = next(a for a in first.assignments if a.round_number == 2)
    second = replan(first, done_rounds=1, cancel_hosts={gone.host_id: 2})
    changes = plan_changes(first, second)
    # By hand: the cancelled host's round 2 fam loses its host and gets an
    # open table. Every other round 2 slot stays, so exactly one change.
    assert [(c.round_number, c.fam_id, c.before, c.after) for c in changes] == [(2, gone.group_id, gone.host_id, None)]
    assert second.kept_slots == 2


def test_replan_changes_minimum_slots(ex):
    first = plan_event(ex.HOSTS, ex.FAMS, 2)
    gone = next(a for a in first.assignments if a.round_number == 2 and a.host_id == "h03")
    second = replan(first, done_rounds=1, cancel_hosts={"h03": 2})
    changes = plan_changes(first, second)
    assert [(c.round_number, c.fam_id, c.after) for c in changes] == [(2, gone.group_id, None)]
    scratch = replan(first, done_rounds=1, cancel_hosts={"h03": 2}, from_scratch=True)
    assert scratch.total_score >= second.total_score
    assert len(plan_changes(first, scratch)) >= len(changes)


def test_replan_keeps_existing_rules(ex):
    rules = [Rule("must", "h04", "fam_01", (2,)), Rule("never", "h01", "fam_02")]
    first = plan_event(ex.HOSTS, ex.FAMS, 2, rules=rules)
    victim = next(a.host_id for a in first.assignments if a.round_number == 2 and a.host_id != "h04")
    second = replan(first, done_rounds=1, cancel_hosts={victim: 2})
    check_invariants(second)
    assert (2, "h04", "fam_01") in second.slots()
    assert not any((a.host_id, a.group_id) == ("h01", "fam_02") for a in second.assignments)


def test_replan_cancelled_host_had_must_rule(ex):
    first = plan_event(ex.HOSTS, ex.FAMS, 2, rules=[Rule("must", "h02", "fam_10", (2,))])
    with pytest.raises(RuleConflictError) as err:
        replan(first, done_rounds=1, cancel_hosts={"h02": 2})
    msg = str(err.value)
    assert "The rule Pharmacy table must meet Bio & Chem fam in round 2 cannot hold" in msg
    assert "Pharmacy table is cancelled from round 2" in msg
    assert "Remove that rule" in msg


def test_fam_no_show(ex):
    first = plan_event(ex.HOSTS, ex.FAMS, 2)
    host_r2 = next(a.host_id for a in first.assignments if a.round_number == 2 and a.group_id == "fam_05")
    second = replan(first, done_rounds=1, cancel_fams={"fam_05": 2})
    check_invariants(second)
    assert {s for s in second.slots() if s[0] == 1} == {s for s in first.slots() if s[0] == 1}
    assert 2 in second.host_breaks.get(host_r2, [])
    row = next(r for r in schedule_rows(second) if r["round"] == 2 and r["fam"] == "Linguistics, CS & Applied Math fam")
    assert row["host_table"] == "Not attending this round"


def test_reprint_list_names_changed_hosts_only(ex):
    first = plan_event(ex.HOSTS, ex.FAMS, 2)
    second = replan(first, done_rounds=1, cancel_hosts={"h03": 2})
    hosts, tents = reprint_list(first, second)
    assert hosts == ["h03"]
    assert tents == []


# ----------------------------------------------------------------------
# 16 to 19: sheets.
# ----------------------------------------------------------------------


def test_duplicate_host_labels_rejected():
    with pytest.raises(SheetError, match="Labels must be unique"):
        load_hosts(io.StringIO("table_label,tags\nPharmacy,a\npharmacy,b\n"))


def test_duplicate_fam_labels_rejected():
    with pytest.raises(SheetError, match="Labels must be unique"):
        load_fams(io.StringIO("fam_label,interests\nBio,a\nBIO,b\n"))


@pytest.mark.parametrize("n_hosts", [10, 8])
def test_schedule_csv_round_trips(n_hosts):
    hosts = load_hosts(ROOT / "templates" / "hosts.csv")[:n_hosts]
    fams = load_fams(ROOT / "templates" / "fams.csv")
    plan = plan_event(hosts, fams, 2)
    text = schedule_csv(plan)
    slots = load_schedule(io.StringIO(text), hosts, fams)
    assert set(slots) == plan.slots()
    again = plan_event(hosts, fams, 2, locked=slots)
    assert schedule_csv(again) == text


def test_schedule_csv_unknown_label_names_row():
    hosts = load_hosts(ROOT / "templates" / "hosts.csv")
    fams = load_fams(ROOT / "templates" / "fams.csv")
    bad = "round,table,fam,host_table,score\n1,1,Public Affairs & Communications,Astronaut,0\n"
    with pytest.raises(SheetError, match="schedule row 2: No host table named 'Astronaut'"):
        load_schedule(io.StringIO(bad), hosts, fams)
