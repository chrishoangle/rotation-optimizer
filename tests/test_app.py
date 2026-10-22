"""Tests for the Streamlit app. Skipped when streamlit is not installed; CI runs them in the app job."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest  # noqa: E402

APP = Path(__file__).resolve().parents[1] / "app" / "streamlit_app.py"


def _solved():
    at = AppTest.from_file(str(APP), default_timeout=60).run()
    assert not at.exception
    at.button[0].click().run()
    assert not at.exception
    return at


def _r1(plan):
    return {s for s in plan.slots() if s[0] == 1}


def test_app_solves_the_template():
    at = _solved()
    assert at.metric[0].value == "341"
    assert at.metric[1].value == "Yes"


def test_cancel_host_after_round_1_keeps_round_1():
    """20 and 27: cancel a host from round 2, re-plan, and see exactly what to reprint."""
    at = _solved()
    at.number_input(key="finished").set_value(1).run()
    at.selectbox(key="cancel_host_name").select("Therapy & Rehab").run()
    at.button(key="cancel_host_btn").click().run()
    assert "Cancelled from round 2: Therapy & Rehab" in [m.value for m in at.markdown]
    at.button(key="replan_btn").click().run()
    assert not at.exception
    old, new = at.session_state["previous"], at.session_state["plan"]
    assert _r1(new) == _r1(old)
    changes = next(df for df in (d.value for d in at.dataframe) if "before" in df.columns)
    assert list(changes["round"]) == [2]
    assert list(changes["before"]) == ["Therapy & Rehab"]
    assert list(changes["after"]) == ["No host"]
    texts = " ".join(m.value for m in at.markdown)
    assert "Reprint these host cards:** Therapy & Rehab" in texts
    assert "Reprint these table tents:** none" in texts
    assert any(b.label == "Download only the host cards to reprint" for b in at.download_button)


def test_cancel_fam_after_round_1():
    at = _solved()
    at.number_input(key="finished").set_value(1).run()
    at.selectbox(key="cancel_fam_name").select("Bio & Chem").run()
    at.button(key="cancel_fam_btn").click().run()
    at.button(key="replan_btn").click().run()
    assert not at.exception
    new = at.session_state["plan"]
    assert new.fam_away == {"fam_10": [2]}
    assert not any(a.group_id == "fam_10" and a.round_number == 2 for a in new.assignments)


def test_deleting_a_host_row_after_lock_is_blocked():
    """21: removing a row once a round is finished shows the cancel action instead."""
    at = _solved()
    at.number_input(key="finished").set_value(1).run()
    at.session_state["hosts"] = {"edited_rows": {}, "added_rows": [], "deleted_rows": [2]}
    at.run()
    errors = " ".join(e.value for e in at.error)
    assert "You removed Therapy & Rehab" in errors
    assert "use Cancel a host or Cancel a fam" in errors
    assert at.button(key="replan_btn").disabled


def test_must_rule_from_rules_table_is_honored():
    """22: a must rule typed into the rules table holds in the plan."""
    at = AppTest.from_file(str(APP), default_timeout=60).run()
    at.session_state["rules"] = {
        "edited_rows": {},
        "added_rows": [{"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": "2"}],
        "deleted_rows": [],
    }
    at.run()
    at.button[0].click().run()
    assert not at.exception
    assert (2, "h02", "fam_10") in at.session_state["plan"].slots()


def test_conflicting_rules_show_plain_words():
    at = AppTest.from_file(str(APP), default_timeout=60).run()
    at.session_state["rules"] = {
        "edited_rows": {},
        "added_rows": [
            {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": ""},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": ""},
        ],
        "deleted_rows": [],
    }
    at.run()
    at.button[0].click().run()
    errors = " ".join(e.value for e in at.error)
    assert "Pharmacy must meet Bio & Chem conflicts with the rule Pharmacy never meet Bio & Chem" in errors
