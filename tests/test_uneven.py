"""Uneven events: more host tables than fams, or more fams than host tables.

The planner spreads the empty rounds evenly before it maximizes score, so
no alum is left without a table while there is room, and no fam waits for a
host twice while another fam always has one. These tests check the spread
on the cases a coordinator found, and the warnings when a gap cannot be
avoided.
"""

from __future__ import annotations

import collections
import csv
from pathlib import Path

from rotation_optimizer.models import GuestGroup, Host
from rotation_optimizer.planning import RuleConflictError, plan_event

ROOT = Path(__file__).resolve().parents[1]
TAGS = ["medicine", "law", "software", "data", "art", "finance", "policy", "biology", "teaching", "engineering",
        "physics", "writing", "music", "business", "design", "nursing", "chemistry", "economics", "history", "film"]


def practice() -> tuple[list[Host], list[GuestGroup]]:
    def rows(name):
        return list(csv.DictReader((ROOT / "templates" / name).open(encoding="utf-8-sig")))

    hosts = [Host.make(f"h{i:02d}", r["Host table name"], r["Host table name"], r["Tags"].split(";"))
             for i, r in enumerate(rows("practice_hosts.csv"), start=1)]
    fams = [GuestGroup.make(f"fam_{i:02d}", r["Fam name"], r["Interests"].split(";"))
            for i, r in enumerate(rows("practice_fams.csv"), start=1)]
    return hosts, fams


def synthetic(n_hosts: int, n_fams: int) -> tuple[list[Host], list[GuestGroup]]:
    hosts = [Host.make(f"h{i:02d}", f"Host {i + 1}", f"Host {i + 1}",
                       [TAGS[i % 20], TAGS[(i * 7 + 3) % 20], TAGS[(i * 3 + 1) % 20]]) for i in range(n_hosts)]
    fams = [GuestGroup.make(f"f{i:02d}", f"Fam {i + 1}", [TAGS[(i * 2) % 20], TAGS[(i * 5 + 5) % 20]])
            for i in range(n_fams)]
    return hosts, fams


def hosting(plan) -> dict[str, int]:
    count = collections.Counter(a.host_id for a in plan.assignments)
    return {h.host_id: count[h.host_id] for h in plan.hosts}


def hosted(plan) -> dict[str, int]:
    count = collections.Counter(a.group_id for a in plan.assignments)
    return {f.group_id: count[f.group_id] for f in plan.fams}


def test_two_extra_alums_each_get_a_table():
    """The coordinator's case: 12 host tables, 10 fams, 2 rounds left Film & TV with no table."""
    hosts, fams = practice()
    hosts += [Host.make("h11", "Real Estate", "Real Estate", ["real estate", "finance"]),
              Host.make("h12", "Film & TV", "Film & TV", ["film", "television", "writing"])]
    plan = plan_event(hosts, fams, 2)
    assert min(hosting(plan).values()) == 1
    assert not [w for w in plan.warnings if "has no table" in w]
    # The extra tables only fill rounds no one else needed: the score is the 10 by 10 optimum.
    assert plan.total_score == plan_event(hosts[:10], fams, 2).total_score == 705
    assert plan.proven_optimal


def test_hosting_is_spread_evenly_when_hosts_far_outnumber_fams():
    hosts, fams = synthetic(30, 8)
    plan = plan_event(hosts, fams, 5)  # 40 places for 30 host tables
    assert sorted(set(hosting(plan).values())) == [1, 2]
    assert plan.proven_optimal


def test_open_tables_are_spread_when_fams_outnumber_hosts():
    """8 host tables, 11 fams, 3 rounds: 9 open tables, so no fam needs more than one."""
    hosts, fams = synthetic(8, 11)
    plan = plan_event(hosts, fams, 3)
    assert min(hosted(plan).values()) == 2
    assert not [w for w in plan.warnings if "some fams wait a round" in w]


def test_unavoidable_gaps_are_named():
    hosts, fams = synthetic(6, 2)
    plan = plan_event(hosts, fams, 2)  # 4 places for 6 host tables
    no_table = [w for w in plan.warnings if "has no table in any round" in w]
    assert len(no_table) == 2
    assert "Seat two alums at one host table, or add a round." in no_table[0]

    hosts, fams = synthetic(2, 6)
    plan = plan_event(hosts, fams, 2)  # 8 open tables for 6 fams
    shared = [w for w in plan.warnings if "some fams wait a round without a host" in w]
    assert len(shared) == 2


def test_cancelled_host_is_not_flagged():
    hosts, fams = synthetic(3, 2)
    plan = plan_event(hosts, fams, 2, host_away={"h02": [1, 2]})
    assert not [w for w in plan.warnings if "has no table" in w]


def test_the_weak_round_setting_says_how_to_turn_it_off():
    hosts, fams = practice()
    try:
        plan_event(hosts, fams, 3, weak_limit=1)
    except RuleConflictError as err:
        assert "Untick it in the sidebar" in str(err)
    else:
        raise AssertionError("expected the setting to be impossible for the practice event at 3 rounds")



def test_a_replan_spreads_empty_tables_over_fams_before_keeping_printed_slots():
    # Film arrives for round 2; then Law and Art cancel from round 2. The
    # printed plan would leave some fam waiting twice; the re-plan moves
    # printed hosts so every fam waits at most once.
    from rotation_optimizer.event import EventState, normalize_state, solve_event

    topics = ("Law", "Art", "Data", "Music", "Film", "Policy")
    s = EventState(
        rounds=3,
        hosts=[{"table_label": t, "tags": t.lower()} for t in topics],
        fams=[{"fam_label": f"Fam {i + 1}", "interests": t.lower()} for i, t in enumerate(topics)],
        rules=[{"rule": "only in rounds", "host_table": "Film", "fam": "", "rounds": "2, 3"}],
    )
    normalize_state(s)
    s.printed = solve_event(s)
    s.cancel_hosts = {"h01": 2, "h02": 2}
    plan = solve_event(s, keep_printed=True)
    waits = {f.group_id: sum(1 for r in (1, 2, 3) if not any(a.round_number == r and a.group_id == f.group_id for a in plan.assignments))
             for f in plan.fams}
    assert max(waits.values()) == 1, waits
