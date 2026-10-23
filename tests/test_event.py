"""Tests for the event state behind the app: blank rows, validation, staleness,
near-miss tags, the printed baseline, and save and load."""

from __future__ import annotations

import csv
import math
import re
from pathlib import Path

import pytest

from rotation_optimizer import SheetError, plan_changes, reprint_list
from rotation_optimizer.event import (
    EventState,
    apply_spelling,
    check_inputs,
    fingerprint,
    handoff_event,
    is_current,
    load_event,
    near_misses,
    normalize_state,
    normalize_table,
    removed_rows,
    restore_removed_rows,
    save_event,
    solve_event,
    tag_key,
)
from rotation_optimizer.event import HOST_COLUMNS
from rotation_optimizer.planning import fairness_warnings
from rotation_optimizer.models import Assignment, GuestGroup
from rotation_optimizer.sheets import parse_rounds

ROOT = Path(__file__).resolve().parents[1]


def _rows(name):
    return list(csv.DictReader((ROOT / "templates" / name).open()))


@pytest.fixture
def state():
    s = EventState(hosts=_rows("hosts.csv"), fams=_rows("fams.csv"))
    normalize_state(s)
    return s


# ----------------------------------------------------------------------
# Blank rows and NaN cells (P0 item 1).
# ----------------------------------------------------------------------


def test_blank_and_nan_rows_are_dropped():
    rows = [
        {"table_label": "Pharmacy", "tags": "pharmacy", "host_name": float("nan"), "host_id": None},
        {"table_label": None, "tags": float("nan"), "host_name": "", "host_id": None},
        {"table_label": "", "tags": "", "host_name": "", "host_id": ""},
    ]
    out = normalize_table(rows, HOST_COLUMNS, "host_id", "h")
    assert out == [{"host_id": "h01", "table_label": "Pharmacy", "host_name": "", "tags": "pharmacy"}]


def test_a_blank_row_in_the_tables_does_not_break_planning(state):
    state.hosts.append({"table_label": float("nan"), "tags": None})
    state.rules.append({"rule": None, "host_table": None, "fam": None, "rounds": float("nan")})
    plan = solve_event(state)
    assert plan.total_score == 341


def test_ids_survive_deleting_a_row(state):
    before = {r["table_label"]: r["host_id"] for r in state.hosts}
    del state.hosts[0]
    state.hosts.append({"table_label": "Late arrival", "tags": "medicine"})
    normalize_state(state)
    after = {r["table_label"]: r["host_id"] for r in state.hosts}
    assert all(after[k] == v for k, v in before.items() if k in after)
    assert after["Late arrival"] == "h01"  # the freed id is reused only for a new row


# ----------------------------------------------------------------------
# Validation: everything at once, coordinator numbering, blank tags allowed.
# ----------------------------------------------------------------------


def test_all_problems_reported_at_once(state):
    state.hosts[2]["table_label"] = ""
    state.fams[0]["size"] = "six"
    state.rules = [{"rule": "must meet", "host_table": "Astronaut", "fam": "Bio & Chem", "rounds": ""}]
    problems = check_inputs(state).problems
    assert problems == [
        "Row 3 of the host tables has no table name. Add one, or delete the row.",
        "Public Affairs & Communications: the size 'six' is not a whole number.",
        "Pairing rule 1: choose a host table from the list.",
    ]


def test_blank_tags_are_a_warning_not_a_blocker(state):
    state.hosts[1]["tags"] = ""
    state.fams[3]["interests"] = ""
    inputs = check_inputs(state)
    assert inputs.problems == []
    assert "Pharmacy has no tags yet, so it scores 0 with every fam. You can still plan." in inputs.warnings
    assert any(w.startswith("Engineering + Pre-Med has no interests yet") for w in inputs.warnings)
    solve_event(state)


def test_too_many_rounds_is_explained(state):
    state.rounds = 11
    assert check_inputs(state).problems == [
        "Rounds can't be more than the number of host tables (10), or some fam would meet the same host twice."
    ]


# ----------------------------------------------------------------------
# Rules rounds parsing (P1 item 4).
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [("", ()), ("1", (1,)), ("1,2", (1, 2)), ("1;2", (1, 2)), ("2, 1", (1, 2)), ("1 2", (1, 2)),
     ("1 and 2", (1, 2)), (1.0, (1,)), (float("nan"), ()), (None, ())],
)
def test_parse_rounds_accepts_common_forms(text, expected):
    assert parse_rounds(text, 2) == expected


@pytest.mark.parametrize("text, message", [("3", "there is no round 3, the event has 2 rounds"), ("1.5", "is not a list of round numbers"), ("first", "is not a list of round numbers")])
def test_parse_rounds_rejects_clearly(text, message):
    with pytest.raises(ValueError, match=message):
        parse_rounds(text, 2)


# ----------------------------------------------------------------------
# Out of date (P1 item 6).
# ----------------------------------------------------------------------


def test_plan_goes_out_of_date_when_inputs_change(state):
    solve_event(state)
    assert is_current(state)
    state.finished = 1
    assert is_current(state)  # finishing a round changes nothing in the schedule
    state.hosts[0]["tags"] += "; nephrology"
    assert not is_current(state)
    solve_event(state)
    state.cancel_hosts["h03"] = 2
    assert not is_current(state)


# ----------------------------------------------------------------------
# Removed rows and restore (P1 item 7).
# ----------------------------------------------------------------------


def test_restore_removed_rows(state):
    solve_event(state)
    state.finished = 1
    gone = [r for r in state.hosts if r["host_id"] == "h03"]
    state.hosts = [r for r in state.hosts if r["host_id"] != "h03"]
    state.fams = state.fams[:-1]
    assert removed_rows(state) == ["Therapy & Rehab", "Bio & Chem"]
    assert restore_removed_rows(state) == ["Therapy & Rehab", "Bio & Chem"]
    assert removed_rows(state) == []
    restored = next(r for r in state.hosts if r["host_id"] == "h03")
    assert restored["tags"] == gone[0]["tags"]
    assert fingerprint(state) != ""


# ----------------------------------------------------------------------
# Near-miss tags (P2 item 12).
# ----------------------------------------------------------------------


def test_tag_key_ignores_case_spaces_hyphens_and_plural():
    assert tag_key("Pre-Med") == tag_key("premed") == tag_key("pre med") == tag_key("pre-meds")
    assert tag_key("business") == "business"  # "ss" is not a plural


def test_near_miss_suggests_and_fixes():
    s = EventState(
        hosts=[{"table_label": "MD", "tags": "premed; medicine"}, {"table_label": "Mentor", "tags": "pre med"}],
        fams=[{"fam_label": "Bio", "interests": "pre-med; Medicines"}, {"fam_label": "Chem", "interests": "pre-med"}],
    )
    normalize_state(s)
    misses = near_misses(s.hosts, s.fams)
    assert [(m.spellings, m.suggestion) for m in misses] == [
        (("medicine", "medicines"), "medicine"),
        (("pre med", "pre-med", "premed"), "pre-med"),
    ]
    for m in misses:
        apply_spelling(s, m)
    assert near_misses(s.hosts, s.fams) == []
    assert s.hosts[0]["tags"] == "pre-med; medicine"


def test_same_spelling_on_one_side_only_is_not_flagged():
    s = EventState(hosts=[{"table_label": "A", "tags": "pre-med; premed"}], fams=[{"fam_label": "X", "interests": "biology"}])
    normalize_state(s)
    assert near_misses(s.hosts, s.fams) == []


# ----------------------------------------------------------------------
# Fairness check (P2 item 13).
# ----------------------------------------------------------------------


def test_fairness_flags_two_weak_rounds():
    fams = [GuestGroup.make("f1", "Public Affairs", ["policy"])]
    real = [Assignment(1, "h2", "f1", 0)]
    out = fairness_warnings(fams, real, 2, {}, {"h2": "Pharmacy"})
    assert out == [
        "Fairness check: Public Affairs gets no host or a 0-score host in 2 rounds (round 1: Pharmacy, "
        "no shared interests; round 2: no host). Consider a must meet rule for this fam."
    ]
    assert fairness_warnings(fams, real, 2, {"f1": [2]}, {"h2": "Pharmacy"}) == []


# ----------------------------------------------------------------------
# Printed baseline (P3 items 14 and 15).
# ----------------------------------------------------------------------


def test_changes_are_listed_against_the_printed_version(state):
    solve_event(state)
    state.printed = state.plan
    state.finished = 1
    state.cancel_hosts["h03"] = 2
    solve_event(state)
    first = state.plan
    state.cancel_fams["fam_05"] = 2
    solve_event(state)
    since_printed = plan_changes(state.printed, state.plan)
    since_last = plan_changes(first, state.plan)
    # The cancelled host's printed round 2 slot shows as a change against the
    # printed version, but not against the last re-plan, which already had it.
    assert any(c.before == "h03" for c in since_printed)
    assert not any(c.before == "h03" for c in since_last)
    out = reprint_list(state.printed, state.plan)
    assert "h03" not in out.host_ids  # cancelled, not coming
    assert out.seating_chart
    assert all(c.round_number == 2 for c in since_printed)


def test_replan_keeps_the_printed_slots_not_the_last_replan(state):
    solve_event(state)
    state.printed = state.plan
    printed_r2 = {s for s in state.printed.slots() if s[0] == 2}
    state.finished = 1
    state.cancel_hosts["h03"] = 2
    solve_event(state)
    state.cancel_hosts.pop("h03")  # the host turns up after all
    solve_event(state)
    assert {s for s in state.plan.slots() if s[0] == 2} == printed_r2


# ----------------------------------------------------------------------
# Save and load (P0 item 3).
# ----------------------------------------------------------------------


def test_save_and_load_round_trip(state):
    state.rules = [
        {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": "2"},
        {"rule": "never meet", "host_table": "Physician (MD)", "fam": "Cog Sci & Pre-Health", "rounds": ""},
        {"rule": "only in rounds", "host_table": "Academic Mentorship", "fam": "", "rounds": "1"},
    ]
    state.hosts[0]["host_name"] = "Host A"
    state.fams[0]["students"] = "Student One; Student Two"
    solve_event(state)
    state.printed = state.plan
    state.finished = 1
    state.cancel_hosts["h03"] = 2
    state.cancel_fams["fam_05"] = 2
    solve_event(state)

    loaded = load_event(save_event(state))
    assert loaded.hosts == state.hosts and loaded.fams == state.fams and loaded.rules == state.rules
    assert (loaded.finished, loaded.cancel_hosts, loaded.cancel_fams) == (1, {"h03": 2}, {"fam_05": 2})
    assert loaded.plan.slots() == state.plan.slots()
    assert loaded.printed.slots() == state.printed.slots()
    assert loaded.plan.free_rounds == state.plan.free_rounds
    assert loaded.plan.fams[0].members == ("Student One", "Student Two")
    assert loaded.plan.hosts[0].person == "Host A"
    assert is_current(loaded)
    assert save_event(loaded) == save_event(state)

    # The loaded event keeps working: a later cancellation re-plans with round 1 locked.
    loaded.cancel_hosts["h06"] = 2
    solve_event(loaded)
    assert {s for s in loaded.plan.slots() if s[0] == 1} == {s for s in state.plan.slots() if s[0] == 1}


def test_loading_something_else_is_a_plain_error():
    with pytest.raises(SheetError, match="not a saved event"):
        load_event("hello")
    with pytest.raises(SheetError, match="not a saved event"):
        load_event('{"format": "other"}')


# ----------------------------------------------------------------------
# Second review: availability wording, uploads, fairness, reprint pages.
# ----------------------------------------------------------------------


def test_only_in_rounds_is_availability_not_cancellation(state):
    from rotation_optimizer import host_cards_html, host_view_rows, seating_chart_html

    state.rules = [{"rule": "only in rounds", "host_table": "Pharmacy", "fam": "", "rounds": "1"}]
    plan = solve_event(state)
    assert plan.host_limits == {"h02": [2]} and plan.host_away == {}
    card = host_cards_html(plan, host_ids=["h02"])
    assert "Not hosting this round" in card
    assert "Cancelled" not in card and "None" not in card
    chart = seating_chart_html(plan)
    assert re.search(r"Not hosting this round: [^<]*\(?Pharmacy\)?: round 1 only", chart)
    assert "Cancelled" not in chart and "None" not in chart
    row = next(r for r in host_view_rows(plan) if r["host_table"] == "Pharmacy")
    assert row["round 2"] == "Not hosting (round 1 only)"


def test_no_printout_says_none(state):
    from rotation_optimizer import host_cards_html, seating_chart_html, table_tents_html

    state.fams = state.fams[:7]  # more hosts than fams, so some hosts get no table
    plan = solve_event(state)
    for page in (host_cards_html(plan), seating_chart_html(plan), table_tents_html(plan)):
        assert ">None<" not in page and "None ·" not in page
    assert "No table this round" in host_cards_html(plan)


def test_column_report_names_missing_columns_once():
    from rotation_optimizer.sheets import column_report, rename_columns

    problems, notices, mapping = column_report(["host_id", "name", "tags"], "hosts")
    assert problems == ["Choose the column in your file that holds the host table name. Columns found: host_id, name, tags."]
    assert mapping == {"host_name": "name", "tags": "tags"}
    assert notices == []
    problems, notices, _ = column_report(["table_label", "host_name"], "hosts")
    assert problems == []
    assert notices == ["No tags column, so every host will score 0 until you add tags."]
    rows = rename_columns([{"table": "Law", "name": "Alum Z", "Email": "x"}], {"table_label": "table", "host_name": "name"})
    assert rows == [{"table_label": "Law", "host_name": "Alum Z"}]


def test_friendly_and_google_forms_headers_are_matched():
    from rotation_optimizer.sheets import match_columns

    assert match_columns(["Host table name", "Alum's name", "Tags"], "hosts") == {
        "table_label": "Host table name", "host_name": "Alum's name", "tags": "Tags"}
    form = ["Timestamp", "Email Address", "What is your full name?", "Which career table will you host?",
            "What topics can you talk about? (pick all)"]
    assert match_columns(form, "hosts") == {
        "table_label": "Which career table will you host?", "host_name": "What is your full name?",
        "tags": "What topics can you talk about? (pick all)"}
    form = ["Timestamp", "Email address", "Your name", "Fam", "Table number", "Intended major(s)"]
    assert match_columns(form, "fams") == {
        "table_number": "Table number", "fam_label": "Fam", "students": "Your name", "interests": "Intended major(s)"}


def test_one_student_per_row_is_grouped_into_fams():
    from rotation_optimizer.sheets import group_student_rows

    rows = [
        {"fam_label": "Bio & Chem", "students": "Student 01", "interests": "biology, chemistry", "table_number": "3"},
        {"fam_label": "Bio & Chem", "students": "Student 02", "interests": "Chemistry; pre-med", "table_number": ""},
        {"fam_label": "Humanities", "students": "Student 03", "interests": "history", "table_number": ""},
    ]
    grouped, count = group_student_rows(rows)
    assert count == 3
    assert grouped == [
        {"table_number": "3", "fam_label": "Bio & Chem", "size": "2", "interests": "biology; chemistry; pre-med",
         "students": "Student 01; Student 02"},
        {"table_number": "", "fam_label": "Humanities", "size": "1", "interests": "history", "students": "Student 03"},
    ]
    one_per_fam = [{"fam_label": "A"}, {"fam_label": "B"}]
    assert group_student_rows(one_per_fam) == (one_per_fam, 0)


def test_templates_have_friendly_headers_and_an_example_row_that_is_skipped():
    import io

    from rotation_optimizer.sheets import drop_example_rows, load_hosts, template_csv

    text = template_csv("hosts")
    assert text.splitlines()[0] == "Host table name,Alum's name,Tags"
    assert "(example)" in text.splitlines()[1]
    rows, skipped = drop_example_rows(list(csv.DictReader(io.StringIO(text))))
    assert (rows, skipped) == ([], 1)
    hosts = load_hosts(io.StringIO(text + "Law,Alum Z,law; policy\n"))
    assert [h.name for h in hosts] == ["Law"]


def test_all_blank_tags_is_one_notice(state):
    for r in state.hosts:
        r["tags"] = ""
    warnings = check_inputs(state).warnings
    assert [w for w in warnings if "tags" in w] == [
        "No host table has tags yet, so every pairing scores 0. Add tags to match hosts to fams. You can still plan."
    ]


def test_fairness_flags_a_low_total_even_with_one_bad_round():
    # The example event has several best schedules, so build the case directly.
    fams = [GuestGroup.make(f"f{i}", name, ["x"]) for i, name in enumerate(["Bio", "Chem", "Physics", "Public Affairs"])]
    real = [Assignment(r, "h1", f"f{i}", score) for i, scores in enumerate([(20, 20), (19, 19), (25, 15), (8, 0)])
            for r, score in zip((1, 2), scores)]
    out = fairness_warnings(fams, real, 2, {}, {"h1": "Pharmacy"})
    assert out == [
        "Fairness check: Public Affairs scores 8 in total, far below the typical fam (40). Consider a must meet "
        "rule for this fam, or turn on \"No fam gets more than one weak round\"."
    ]


def test_one_weak_round_setting(state):
    state.one_weak_round = True
    plan = solve_event(state)
    for f in plan.fams:
        weak = sum(1 for r in (1, 2) if not any(
            a.group_id == f.group_id and a.round_number == r and a.score > 0 for a in plan.assignments))
        assert weak <= 1, f.name


def test_reprint_names_seating_pages_and_prints_only_them(state):
    from rotation_optimizer import seating_chart_html

    solve_event(state)
    state.printed = state.plan
    state.finished = 1
    state.cancel_hosts["h03"] = 2
    plan = solve_event(state)
    out = reprint_list(state.printed, plan)
    assert out.seating_rounds == [2] and out.finder_page is False
    assert "seating chart, round 2 page" in out.describe(plan)
    page = seating_chart_html(plan, rounds=out.seating_rounds, finder=out.finder_page)
    assert "<h2>Round 2</h2>" in page and "<h2>Round 1</h2>" not in page and "Find your table" not in page


def test_available_hosts_do_not_sit_out_while_a_fam_has_no_host(state):
    """A tie-break prefers a real host over an open table; this used to fail about 1 run in 25."""
    for _ in range(15):
        s = EventState(hosts=[dict(r) for r in state.hosts], fams=[dict(r) for r in state.fams], cancel_hosts={"h03": 2})
        plan = solve_event(s)
        assert len([a for a in plan.assignments if a.round_number == 1]) == 10


def test_event_file_saved_before_the_weak_round_setting_stays_up_to_date(state):
    import json

    solve_event(state)
    saved = json.loads(save_event(state))
    saved.pop("one_weak_round", None)
    loaded = load_event(json.dumps(saved))
    assert is_current(loaded)
    loaded.one_weak_round = True
    assert not is_current(loaded)


def test_hand_off_clears_students_and_the_night(state):
    from rotation_optimizer.event import handoff_event

    state.cancel_hosts = {"h03": 2}
    state.finished = 1
    solve_event(state)
    state.printed = state.plan
    out = handoff_event(state)
    assert all(not r["students"] for r in out.fams)
    assert [r["fam_label"] for r in out.fams] == [r["fam_label"] for r in state.fams]
    assert out.hosts == state.hosts and out.rules == state.rules
    assert (out.cancel_hosts, out.cancel_fams, out.finished) == ({}, {}, 0)
    assert out.plan is None and out.printed is None
    assert "Student 01" not in save_event(out)
    assert any(r["students"] for r in state.fams)  # the original is untouched


def test_before_the_night_checklist_follows_the_event(state):
    from rotation_optimizer.event import before_the_night

    def todo(items):
        return [i.text for i in items if i.status == "todo"]

    items = before_the_night(state, saved=False)
    assert "Find the best schedule (or re-plan): the schedule is missing or out of date." in todo(items)
    assert "Click Save event file in the sidebar and keep the file for the night." in todo(items)
    solve_event(state)
    state.printed = state.plan
    items = before_the_night(state, saved=True)
    assert todo(items) == []
    state.hosts[0]["tags"] = ""
    items = before_the_night(state, saved=True)
    assert "Add tags for 1 host table: Physician (MD)." in todo(items)
    assert "Find the best schedule (or re-plan): the schedule is missing or out of date." in todo(items)


def test_checklist_reads_the_printed_version_after_save_and_reopen(state):
    from rotation_optimizer.event import before_the_night

    solve_event(state)
    state.printed = state.plan
    state.printed_at = "7:12 PM"
    again = load_event(save_event(state))
    assert again.printed_at == "7:12 PM"
    texts = {i.text: i.status for i in before_the_night(again, saved=True)}
    assert texts["The printed version is marked."] == "done"


def test_open_tables_count_as_weak_and_are_named():
    fams = [GuestGroup.make(f"f{i}", name, ["x"]) for i, name in enumerate(["Bio", "Chem", "Physics", "Violet Fam"])]
    real = [Assignment(r, "h1", f"f{i}", score) for i, scores in enumerate([(20, 20), (19, 19), (25, 15)])
            for r, score in zip((1, 2), scores)] + [Assignment(1, "h1", "f3", 10)]
    out = fairness_warnings(fams, real, 2, {}, {"h1": "Pharmacy"})
    assert out == [
        "Fairness check: Violet Fam scores 10 in total, far below the typical fam (40). It had no host in round 2. "
        "Consider a must meet rule for this fam, or turn on \"No fam gets more than one weak round\"."
    ]


def test_weak_count_includes_open_tables():
    from rotation_optimizer.event import EventState

    s = EventState(hosts=[{"table_label": "Law", "tags": "law"}],
                   fams=[{"fam_label": "A", "interests": "law"}, {"fam_label": "B", "interests": "art"}], rounds=1)
    normalize_state(s)
    plan = solve_event(s)
    assert len(plan.open_slots()) == 1 and plan.weak_count() == 1


def test_duplicate_fam_names_without_students_are_not_merged():
    from rotation_optimizer.sheets import fams_from_rows, group_student_rows

    rows = [{"fam_label": "Red", "interests": "law"}, {"fam_label": "Red", "interests": "art"},
            {"fam_label": "Blue", "interests": "math"}]
    out, grouped = group_student_rows(rows)
    assert (out, grouped) == (rows, 0)
    problems = fams_from_rows(out)[1]
    assert "Two fams are named Red. Each fam needs its own name." in problems


def test_near_misses_include_short_forms():
    hosts = [{"table_label": "A", "tags": "math; econ"}]
    fams = [{"fam_label": "X", "interests": "mathematics; economics; computer science"}]
    found = {m.spellings for m in near_misses(hosts, fams)}
    assert found == {("math", "mathematics"), ("econ", "economics")}


def test_check_in_notes_and_night_log_survive_save_and_hand_off():
    state = EventState(title="Dinner", hosts=[{"table_label": "Law", "tags": "law"}], fams=[{"fam_label": "Red", "interests": "law"}],
                       arrived=["h01"], notes="Table 7 is by the kitchen.",
                       night_log=[{"at": "7:42 PM", "text": "Law cancelled from round 2."}])
    normalize_state(state)
    loaded = load_event(save_event(state))
    assert (loaded.arrived, loaded.notes, loaded.night_log) == (state.arrived, state.notes, state.night_log)
    hand = handoff_event(state)
    assert hand.notes == "Table 7 is by the kitchen." and hand.arrived == [] and hand.night_log == []


def test_files_saved_before_check_in_existed_still_open():
    import json

    old = json.loads(save_event(EventState()))
    for key in ("arrived", "notes", "night_log"):
        del old[key]
    loaded = load_event(json.dumps(old))
    assert (loaded.arrived, loaded.notes, loaded.night_log) == ([], "", [])
