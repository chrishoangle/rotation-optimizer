"""Coordinator flows against the real Streamlit app. Skipped when streamlit is
not installed; CI runs them in the app job."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest  # noqa: E402

from rotation_optimizer.event import load_event, save_event  # noqa: E402

APP = Path(__file__).resolve().parents[1] / "app" / "streamlit_app.py"
FIND = "Apply and find the best schedule"
REPLAN_FORM = "Apply and re-plan"


def _app(state=None):
    at = AppTest.from_file(str(APP), default_timeout=60)
    if state is not None:
        at.session_state["event"] = state
        at.session_state["editor_version"] = 0
    return at.run()


def _click(at, label):
    next(b for b in at.button if b.label == label).click().run()
    assert not at.exception
    return at


def _edit(at, table, change):
    at.session_state[f"{table}_{at.session_state['editor_version']}"] = {
        "edited_rows": change.get("edited", {}), "added_rows": change.get("added", []), "deleted_rows": change.get("deleted", [])
    }


def _texts(elements):
    return " ".join(e.value for e in elements)


def _solved():
    return _click(_app(), FIND)


def _finish_round_1(at):
    at.number_input(key=f"finished_{at.session_state['editor_version']}").set_value(1).run()
    return at


def test_app_solves_the_template():
    at = _solved()
    assert at.metric[0].value == "341"
    assert at.metric[1].value == "Yes"


def test_blank_row_does_not_crash():
    """Repro 1: add a blank host row, edit another cell, apply."""
    at = _app()
    _edit(at, "hosts", {"added": [{}], "edited": {"0": {"tags": "pre-med; medicine; healthcare"}}})
    _click(at, "Apply changes")
    assert "went wrong" not in _texts(at.error)
    assert any(s.value == "3. Pairing rules (optional)" for s in at.subheader)
    assert len(at.session_state["event"].hosts) == 10


def test_rules_survive_reruns_and_errors():
    """Repro 2: rules live in the event, not only in the editor."""
    at = _app()
    _edit(at, "rules", {"added": [{"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": "2"}]})
    _click(at, "Apply changes")
    at.run().run()
    assert at.session_state["event"].rules[0]["host_table"] == "Pharmacy"
    _edit(at, "hosts", {"edited": {"1": {"table_label": ""}}})  # a problem elsewhere
    _click(at, "Apply changes")
    assert "host 2: the table name is empty." in _texts(at.error)
    assert at.session_state["event"].rules[0]["rounds"] == "2"


def test_only_in_rounds_rule_keeps_its_round():
    """Repro 4: rule = only in rounds, host = Pharmacy, rounds = 1."""
    at = _app()
    _edit(at, "rules", {"added": [{"rule": "only in rounds", "host_table": "Pharmacy", "rounds": "1"}]})
    _click(at, FIND)
    plan = at.session_state["event"].plan
    assert plan.host_limits == {"h02": [2]}
    assert plan.host_away == {}  # availability, not a cancellation
    assert not any(a.host_id == "h02" and a.round_number == 2 for a in plan.assignments)


def test_all_problems_shown_at_once():
    """Repro 8."""
    at = _app()
    _edit(at, "hosts", {"edited": {"2": {"table_label": ""}}})
    _edit(at, "fams", {"edited": {"0": {"size": "six"}}})
    _click(at, "Apply changes")
    errors = _texts(at.error)
    assert "host 3: the table name is empty." in errors
    assert "fam 1 (Public Affairs & Communications): the size 'six' is not a whole number." in errors


def test_blank_tags_still_plan():
    """Repro 9."""
    at = _app()
    _edit(at, "hosts", {"edited": {"1": {"tags": ""}}})
    _click(at, FIND)
    assert "host 2 (Pharmacy) has no tags yet" in _texts(at.warning)
    assert at.session_state["event"].plan is not None


def test_out_of_date_hides_downloads():
    """Repro 6: change an input after planning."""
    at = _solved()
    assert any(b.label == "Host cards" for b in at.download_button)
    _edit(at, "hosts", {"edited": {"0": {"tags": "pre-med; medicine"}}})
    _click(at, "Apply changes")
    assert "Out of date" in _texts(at.warning)
    assert not any(b.label in ("Host cards", "Seating chart", "Table tents", "Schedule CSV") for b in at.download_button)
    _click(at, REPLAN_FORM)
    assert "Out of date" not in _texts(at.warning)


def test_restore_removed_rows_and_guard_only_after_round_1():
    """Repros 7 and 10."""
    at = _solved()
    _finish_round_1(at)
    _edit(at, "hosts", {"deleted": [2]})
    _click(at, "Apply changes")
    assert "You removed Therapy & Rehab" in _texts(at.error)
    assert at.button(key="replan_btn").disabled
    at.number_input(key=f"finished_{at.session_state['editor_version']}").set_value(0).run()
    assert "You removed" not in _texts(at.error)
    _finish_round_1(at)
    _click(at, "Restore removed rows")
    assert "You removed" not in _texts(at.error)
    assert any(r["table_label"] == "Therapy & Rehab" for r in at.session_state["event"].hosts)


def test_near_miss_one_click_fix():
    """Repro 12."""
    at = _app()
    _edit(at, "fams", {"edited": {"1": {"interests": "premed; healthcare; nursing"}}})
    _click(at, "Apply changes")
    assert "Did you mean the same thing by pre-med / premed?" in _texts(at.info)
    _click(at, "Use 'pre-med' everywhere")
    assert "Did you mean" not in _texts(at.info)


def test_full_flow_survives_save_and_load():
    """Done-when: plan, 3 rules, finish round 1, cancel a host and a fam, re-plan, then reload."""
    at = _solved()
    _edit(at, "rules", {"added": [
        {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": "2"},
        {"rule": "never meet", "host_table": "Physician (MD)", "fam": "Cog Sci & Pre-Health", "rounds": ""},
        {"rule": "only in rounds", "host_table": "Academic Mentorship", "rounds": "1"},
    ]})
    _click(at, REPLAN_FORM)
    _click(at, "Mark as printed")
    _finish_round_1(at)
    at.selectbox(key="cancel_host_name").select("Therapy & Rehab").run()
    _click(at, "Cancel host")
    at.selectbox(key="cancel_fam_name").select("Engineering & Psych").run()
    _click(at, "Cancel fam")
    assert "Out of date" in _texts(at.warning)
    _click(at, "Re-plan")
    event = at.session_state["event"]
    assert {s for s in event.plan.slots() if s[0] == 1} == {s for s in event.printed.slots() if s[0] == 1}
    assert (2, "h02", "fam_10") in event.plan.slots()
    changes = next(df.value for df in at.dataframe if "Printed" in df.value.columns)
    assert set(changes["Round"]) == {2}
    assert "Not attending this round" in set(changes["Now"])
    text = _texts(at.markdown)
    assert "Therapy & Rehab: cancelled from round 2" in text  # repro 16: still listed after re-plan
    assert "Engineering & Psych: cancelled from round 2" in text
    assert "seating chart, round 2 page" in text and "host card for Therapy & Rehab" not in text  # repro 15

    saved = save_event(event)
    again = _app(load_event(saved))
    assert not again.exception
    assert "Out of date" not in _texts(again.warning)
    assert again.session_state["event"].plan.slots() == event.plan.slots()
    assert any(df.value is not None and "Printed" in df.value.columns for df in again.dataframe)


def test_conflicting_rules_show_plain_words():
    at = _app()
    _edit(at, "rules", {"added": [
        {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": ""},
        {"rule": "never meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": ""},
    ]})
    _click(at, FIND)
    assert "Pharmacy must meet Bio & Chem conflicts with the rule Pharmacy never meet Bio & Chem" in _texts(at.error)


# ----------------------------------------------------------------------
# Second review: P2 to P5.
# ----------------------------------------------------------------------


def test_only_in_rounds_conflict_is_worded_as_availability():
    """P2: a must rule in a round the host does not come."""
    at = _app()
    _edit(at, "rules", {"added": [
        {"rule": "only in rounds", "host_table": "Pharmacy", "rounds": "1"},
        {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": "2"},
    ]})
    _click(at, FIND)
    errors = _texts(at.error)
    assert "because Pharmacy only comes for round 1 (pairing rule). Change one of the two rules." in errors
    assert "cancelled" not in errors.lower()


def test_rule_error_shows_by_the_tables_and_clears_when_fixed():
    """P4.4 and P4.5."""
    at = _app()
    _edit(at, "rules", {"added": [
        {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": ""},
        {"rule": "never meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": ""},
    ]})
    _click(at, FIND)
    assert "conflicts with the rule" in _texts(at.error)
    _edit(at, "rules", {"deleted": [1]})
    _click(at, "Apply changes")
    assert "conflicts with the rule" not in _texts(at.error)


def test_too_many_rounds_snaps_back_with_visible_text():
    """P5: rounds above the limit."""
    at = _app()
    at.number_input(key="rounds_0").set_value(11).run()
    assert at.session_state["event"].rounds == 10
    assert "Rounds can't be more than the number of host tables (10)" in _texts(at.sidebar.warning)


def test_unfinish_a_locked_round_needs_a_confirmation():
    """P3.4."""
    at = _solved()
    _finish_round_1(at)
    at.selectbox(key="cancel_host_name").select("Therapy & Rehab").run()
    _click(at, "Cancel host")
    _click(at, "Re-plan")
    assert at.session_state["event"].plan.locked_rounds == [1]
    at.number_input(key=f"finished_{at.session_state['editor_version']}").set_value(0).run()
    assert "Round 1 is locked because you re-planned after it finished" in _texts(at.warning)
    assert at.session_state["event"].finished == 1  # not until confirmed
    _click(at, "Un-finish round 1")
    assert at.session_state["event"].plan.locked_rounds == []
    assert at.session_state["event"].finished == 0


def test_restore_clears_out_of_date_and_keeps_the_row_position():
    """P4.3."""
    at = _solved()
    _finish_round_1(at)
    order = [r["host_id"] for r in at.session_state["event"].hosts]
    _edit(at, "hosts", {"deleted": [2]})
    _click(at, "Apply changes")
    assert "Out of date" in _texts(at.warning)
    _click(at, "Restore removed rows")
    assert [r["host_id"] for r in at.session_state["event"].hosts] == order
    assert "Out of date" not in _texts(at.warning)


def test_upload_preview_confirm_and_undo():
    """P3.2 and P3.3: an uploaded hosts file waits for confirmation and can be undone."""
    at = _app()
    at.session_state["pending_upload"] = {
        "kind": "hosts", "name": "signups.csv", "id": "u1",
        "rows": [{"Timestamp": "1", "Email": "z@example.com", "Career table": "Law", "Your name": "Alum Z", "tags": "law; policy"},
                 {"Timestamp": "2", "Email": "y@example.com", "Career table": "Film", "Your name": "Alum Y", "tags": "film"}],
        "columns": ["Timestamp", "Email", "Career table", "Your name", "tags"],
        "mapping": {"host_name": "Your name", "tags": "tags"},
    }
    at.run()
    assert at.button(key="confirm_upload").disabled
    assert any("holds the host table name" in e.value for e in at.error)
    at.selectbox(key="map_u1_table_label").select("Career table").run()
    assert not at.button(key="confirm_upload").disabled
    _click(at, "Replace 10 host tables with these 2")
    assert [r["table_label"] for r in at.session_state["event"].hosts] == ["Law", "Film"]
    assert at.session_state["event"].hosts[0]["host_name"] == "Alum Z"
    assert "z@example.com" not in save_event(at.session_state["event"])
    _click(at, "Undo upload")
    assert len(at.session_state["event"].hosts) == 10


def test_unsaved_changes_are_shown():
    """P3.1: the page says when there are unsaved changes."""
    at = _app()
    assert "No changes since this event was opened." in _texts(at.sidebar.caption)
    _edit(at, "hosts", {"edited": {"0": {"tags": "pre-med; medicine"}}})
    _click(at, "Apply changes")
    assert "Unsaved changes." in _texts(at.sidebar.caption)


def test_one_weak_round_setting():
    """P5: no fam gets more than one weak round when the setting is on."""
    at = _app()
    at.sidebar.checkbox[0].check().run()
    _click(at, FIND)
    plan = at.session_state["event"].plan
    for f in plan.fams:
        weak = sum(1 for r in (1, 2)
                   if not any(a.group_id == f.group_id and a.round_number == r and a.score > 0 for a in plan.assignments))
        assert weak <= 1, f.name


def test_newcomer_path_has_a_guide_four_printouts_and_a_checklist():
    """P6: a guide, the four printouts, the checklist, and starting over."""
    at = _app()
    assert any(e.label.startswith("Start here") for e in at.expander)
    _click(at, FIND)
    labels = {b.label for b in at.download_button}
    assert {"Seating chart", "Host cards", "Table tents", "Run sheet", "Hand off to next year",
            "Save event file (keep this to continue later)"} <= labels
    checklist = next(e for e in at.expander if e.label.startswith("Before the night"))
    assert checklist.label == "Before the night: 2 things left to do"
    _click(at, "Mark as printed")
    assert next(e for e in at.expander if e.label.startswith("Before the night")).label == "Before the night: 1 thing left to do"
    _click(at, "Start a blank event")
    _click(at, "Replace")
    assert at.session_state["event"].hosts == [] and at.session_state["event"].plan is None
    _click(at, "Load the example dinner")
    _click(at, "Replace")
    assert len(at.session_state["event"].hosts) == 10
