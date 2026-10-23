"""Room details on fam tables: where each table is, and whether it has step-free access."""

from __future__ import annotations

import pytest

from rotation_optimizer.event import EventState, fingerprint, fam_locations, is_current, normalize_state, solve_event
from rotation_optimizer.export import host_cards_html, seating_chart_html
from rotation_optimizer.planning import RuleConflictError


def dinner(**kw) -> EventState:
    s = EventState(
        rounds=2,
        hosts=[{"table_label": t, "tags": t.lower()} for t in ("Law", "Art", "Data")],
        fams=[{"fam_label": f"Fam {n}", "interests": i, "location": loc, "step_free": sf}
              for n, i, loc, sf in [("Red", "law", "by the stage", "yes"), ("Blue", "art", "", ""), ("Gold", "data", "back left", "yes")]],
        **kw,
    )
    normalize_state(s)
    return s


def test_location_is_printed_and_never_puts_the_schedule_out_of_date():
    s = dinner()
    plan = solve_event(s)
    assert "by the stage" in host_cards_html(plan, locations=fam_locations(s))
    assert "back left" in seating_chart_html(plan, locations=fam_locations(s))
    assert "by the stage" not in host_cards_html(plan)
    s.fams[1]["location"] = "near the door"
    assert is_current(s)


def test_needs_step_free_keeps_a_host_at_step_free_tables():
    s = dinner(rules=[{"rule": "needs step-free", "host_table": "Art", "fam": "", "rounds": ""}])
    plan = solve_event(s)
    art = {a.group_id for a in plan.assignments if a.host_id == "h02"}
    assert art <= {"fam_01", "fam_03"} and len(art) == 2


def test_needs_step_free_with_no_table_marked_says_what_to_do():
    s = dinner(rules=[{"rule": "needs step-free", "host_table": "Art", "fam": "", "rounds": ""}])
    for r in s.fams:
        r["step_free"] = ""
    with pytest.raises(RuleConflictError, match="no fam table is marked as step-free"):
        solve_event(s)


def test_an_empty_step_free_column_keeps_old_files_current():
    s = dinner()
    for r in s.fams:
        r["step_free"] = ""
        r["location"] = ""
    with_cols = fingerprint(s)
    for r in s.fams:
        del r["step_free"], r["location"]
    assert fingerprint(s) == with_cols


def full_room(**kw) -> EventState:
    """As many alumni as fams, with only one step-free table."""
    topics = ("Law", "Art", "Data", "Music", "Film", "Policy")
    s = EventState(
        rounds=3,
        hosts=[{"table_label": t, "tags": t.lower()} for t in topics],
        fams=[{"fam_label": f"Fam {i + 1}", "interests": t.lower(), "step_free": "yes" if i == 0 else ""} for i, t in enumerate(topics)],
        rules=[{"rule": "needs step-free", "host_table": "Law", "fam": "", "rounds": ""}],
        **kw,
    )
    normalize_state(s)
    return s


def test_a_step_free_host_sits_out_rounds_when_the_room_is_full():
    # Six alumni for six fams: Law can visit the one step-free table once, so
    # Law takes a break in the other rounds instead of making the plan impossible.
    plan = solve_event(full_room())
    law = [a for a in plan.assignments if a.host_id == "h01"]
    assert [a.group_id for a in law] == ["fam_01"]
    assert plan.host_breaks["h01"] == [r for r in (1, 2, 3) if r != law[0].round_number]


def test_no_fam_goes_all_night_without_a_host_after_a_cancellation():
    s = full_room()
    s.printed = solve_event(s)
    s.cancel_hosts = {"h04": 1, "h05": 2}
    plan = solve_event(s, keep_printed=True)
    for f in plan.fams:
        assert any(a.group_id == f.group_id for a in plan.assignments), f.name


def test_hand_off_puts_tables_moved_on_the_night_back():
    from rotation_optimizer.event import handoff_event

    s = dinner()
    s.fams[0].update(table_number="7", location="", step_free="")
    s.night = {"tablesBefore": {"fam_01": {"table_number": "1", "location": "by the stage", "step_free": "yes"}}}
    row = handoff_event(s).fams[0]
    assert (row["table_number"], row["location"], row["step_free"]) == ("1", "by the stage", "yes")
