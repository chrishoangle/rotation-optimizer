"""Tests for the printouts: table numbers, host cards, and table tents."""

from __future__ import annotations

import io
import re
from pathlib import Path

import pytest

from rotation_optimizer import (
    SheetError,
    host_cards_html,
    load_fams,
    load_hosts,
    plan_event,
    replan,
    schedule_rows,
    seating_chart_html,
    table_tents_html,
)

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def plan():
    return plan_event(load_hosts(ROOT / "templates" / "hosts.csv"), load_fams(ROOT / "templates" / "fams.csv"), 2)


def test_blank_table_numbers_fill_the_gaps():
    fams = load_fams(io.StringIO("fam_label,interests,table_number\nA,x,2\nB,y,\nC,z,\n"))
    assert [f.table_number for f in fams] == [2, 1, 3]


def test_bad_table_number_is_reported():
    with pytest.raises(SheetError, match="not a whole number from 1 up"):
        load_fams(io.StringIO("fam_label,interests,table_number\nA,x,0\n"))


def test_duplicate_table_numbers_rejected():
    with pytest.raises(SheetError, match="fam 1 \\(Bio\\) and fam 2 \\(Chem\\) both use table number 3"):
        load_fams(io.StringIO("fam_label,interests,table_number\nBio,a,3\nChem,b,3\n"))


def test_schedule_rows_carry_table_numbers(plan):
    rows = schedule_rows(plan)
    assert [r["table"] for r in rows if r["round"] == 1] == list(range(1, 11))


def test_host_cards_cover_every_host_and_round(plan):
    page = host_cards_html(plan)
    assert page.count('class="hc"') == 10
    assert len(re.findall(r'class="t">Table \d+<', page)) == 20


def test_host_cards_can_be_limited_for_reprinting(plan):
    page = host_cards_html(plan, host_ids=["h03"])
    assert page.count('class="hc"') == 1
    assert "Therapy &amp; Rehab" in page


def test_cancelled_host_card_says_cancelled(plan):
    second = replan(plan, done_rounds=1, cancel_hosts={"h03": 2})
    page = host_cards_html(second, host_ids=["h03"])
    assert "Cancelled for this round" in page


def test_table_tents_one_per_table(plan):
    page = table_tents_html(plan)
    assert page.count('class="tent"') == 10
    assert page.count('class="n">10<') == 2  # both faces of table 10


@pytest.mark.parametrize("render", [host_cards_html, table_tents_html, seating_chart_html])
def test_printouts_have_no_long_dashes(plan, render):
    page = render(plan)
    assert "\u2014" not in page and "\u2013" not in page
    assert "size: letter" in page


# ----------------------------------------------------------------------
# Names on printouts and the find-your-table page (P4 items 17 and 18).
# ----------------------------------------------------------------------


def _named_plan():
    from rotation_optimizer.event import EventState, normalize_state, solve_event
    import csv

    s = EventState(
        hosts=list(csv.DictReader((ROOT / "templates" / "hosts.csv").open())),
        fams=list(csv.DictReader((ROOT / "templates" / "fams.csv").open())),
    )
    normalize_state(s)
    s.hosts[1]["host_name"] = "Host B"
    for row in s.fams:
        row["students"] = ""
    s.fams[0]["students"] = "Zoe Student; amy student"
    s.fams[9]["students"] = "Ben Student"
    return solve_event(s)


def test_host_card_shows_the_host_name():
    page = host_cards_html(_named_plan(), host_ids=["h02"])
    assert '<div class="person">Host B</div>' in page


def test_host_card_lists_shared_interests_first():
    plan = _named_plan()
    page = host_cards_html(plan)
    a = next(a for a in plan.assignments if a.score > 0)
    host = next(h for h in plan.hosts if h.host_id == a.host_id)
    fam = next(f for f in plan.fams if f.group_id == a.group_id)
    shared = ", ".join(sorted(fam.interests & host.tags))
    assert f"<b>You share:</b> {shared}" in page.replace("&amp;", "&")
    assert page.index("You share:") < page.index("Also interested in")


def test_find_your_table_is_alphabetical():
    from rotation_optimizer import find_your_table_rows

    plan = _named_plan()
    assert find_your_table_rows(plan) == [
        ("amy student", 1, "Public Affairs & Communications"),
        ("Ben Student", 10, "Bio & Chem"),
        ("Zoe Student", 1, "Public Affairs & Communications"),
    ]
    assert "Find your table" in seating_chart_html(plan)


def test_no_find_your_table_page_without_names():
    fams = [f.__class__.make(f.group_id, f.name, f.interests, size=f.size, table_number=f.table_number)
            for f in load_fams(ROOT / "templates" / "fams.csv")]
    plan = plan_event(load_hosts(ROOT / "templates" / "hosts.csv"), fams, 2)
    assert "Find your table" not in seating_chart_html(plan)


def test_run_sheet_has_a_timeline_and_check_in_lists():
    from rotation_optimizer import run_sheet_html

    plan = plan_event(load_hosts(ROOT / "templates" / "hosts.csv"), load_fams(ROOT / "templates" / "fams.csv"), 2,
                      host_away={"h03": [2]})
    page = run_sheet_html(plan, "Example dinner", start_time="6:30 PM", round_minutes=20)
    text = re.sub(r"<[^>]+>", " ", page)
    for when, what in [("6:30 PM", "Doors open"), ("6:40 PM", "Welcome"), ("6:45 PM", "Round 1"),
                       ("7:10 PM", "Round 2"), ("7:30 PM", "Closing")]:
        assert re.search(rf"{when}\s+{what}", text), (when, what)
    assert "Cancelled: Therapy &amp; Rehab." in text
    assert "Check-in: host tables" in text and "Alum A" in text and "Check-in: fams" in text
    assert not re.search(r"\bNone\b", text)
    blank = run_sheet_html(plan, "Example dinner")
    assert 'class="blank"' in blank and "PM" not in re.sub(r"<[^>]+>", " ", blank)
