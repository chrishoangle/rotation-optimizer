"""The "stays with" rule: an alum who stays at one fam's table all night.

Coordinators asked for it for alumni who cannot move between tables, and
for sponsors who keep one spot. The fam keeps that host every round, and
no other host visits it.
"""

from __future__ import annotations

import pytest

from rotation_optimizer.event import EventState, check_inputs, normalize_state, solve_event
from rotation_optimizer.planning import Rule, RuleConflictError, plan_event
from test_uneven import practice


def where(plan, host_id):
    return sorted((a.round_number, a.group_id) for a in plan.assignments if a.host_id == host_id)


@pytest.mark.parametrize("fam", ["fam_02", ""])
def test_host_stays_with_one_fam_every_round(fam):
    hosts, fams = practice()
    plan = plan_event(hosts, fams, 3, rules=[Rule("stays", "h03", fam)])
    seats = where(plan, "h03")
    assert [r for r, _ in seats] == [1, 2, 3] and len({f for _, f in seats}) == 1
    if fam:
        assert seats[0][1] == fam
    kept = seats[0][1]
    assert {a.host_id for a in plan.assignments if a.group_id == kept} == {"h03"}
    assert plan.proven_optimal


def test_chosen_fam_is_the_best_one_for_the_host():
    hosts, fams = practice()
    free = plan_event(hosts, fams, 3, rules=[Rule("stays", "h03", "")])
    for f in fams:
        fixed = plan_event(hosts, fams, 3, rules=[Rule("stays", "h03", f.group_id)])
        assert fixed.total_score <= free.total_score


def test_two_hosts_cannot_stay_with_one_fam():
    hosts, fams = practice()
    with pytest.raises(RuleConflictError, match="both stay with Cog Sci & Pre-Health"):
        plan_event(hosts, fams, 2, rules=[Rule("stays", "h03", "fam_02"), Rule("stays", "h02", "fam_02")])


def test_rounds_are_rejected_in_the_rules_table():
    s = EventState(hosts=[{"table_label": "Law", "tags": "law"}, {"table_label": "Art", "tags": "art"}],
                   fams=[{"fam_label": "Red", "interests": "law"}, {"fam_label": "Blue", "interests": "art"}],
                   rules=[{"rule": "stays with", "host_table": "Law", "fam": "", "rounds": "1"}])
    normalize_state(s)
    assert check_inputs(s).problems == ["Pairing rule 1: stays with is for the whole night, so leave Rounds blank."]


def test_staying_host_survives_a_cancellation_on_the_night():
    hosts, fams = practice()
    rows_h = [{"table_label": h.name, "tags": "; ".join(sorted(h.tags))} for h in hosts]
    rows_f = [{"fam_label": f.name, "interests": "; ".join(sorted(f.interests))} for f in fams]
    s = EventState(hosts=rows_h, fams=rows_f, rounds=3,
                   rules=[{"rule": "stays with", "host_table": "Therapy & Rehab", "fam": "", "rounds": ""}])
    solve_event(s)
    before = where(s.plan, "h03")
    s.printed = s.plan
    s.finished = 1
    s.cancel_hosts = {"h02": 2}
    solve_event(s)
    assert where(s.plan, "h03") == before
