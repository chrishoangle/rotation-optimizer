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
    with pytest.raises(SheetError, match="table_number 3 is used by both"):
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
