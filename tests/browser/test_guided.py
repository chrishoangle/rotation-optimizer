"""A first-time coordinator in the guided planner, with no documentation.

Opens the app, makes a new event, pastes alumni and fams from a
spreadsheet, gives one alum a late arrival, makes the schedule, swaps two
alumni by tapping their names, prints, opens night mode, and hands the
event on. Every screen must be in event words, and the first screen must
stay small.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

pytest.importorskip("playwright.sync_api")
sys.path.insert(0, str(Path(__file__).parent))

from test_web import APP, JARGON, button, url  # noqa: E402,F401  (url is the server fixture)

pytestmark = pytest.mark.skipif(not (APP / "app.js").exists(), reason="build the web app first: cd web && npm run build")

GUIDED_JARGON = JARGON + [r"\bscore\b", r"\btags?\b", r"\bre-plan\b", r"\bhost table\b", r"\bpairing rule\b", r"\bweak\b"]


@pytest.fixture()
def page(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        p = ctx.new_page()
        errors: list[str] = []
        p.on("pageerror", lambda e: errors.append(str(e)))
        p.goto(url)
        p.wait_for_selector("text=Plan a rotation dinner")
        yield p
        assert errors == []
        browser.close()


def words(p) -> str:
    return p.inner_text("main")


def jargon(p) -> list[str]:
    return [j for j in GUIDED_JARGON if re.search(j, words(p))]


def paste(p, locator, text: str) -> None:
    p.evaluate("t => navigator.clipboard.writeText(t)", text)
    locator.click()
    p.keyboard.press("ControlOrMeta+V")
    p.wait_for_timeout(150)


def visible_buttons(p) -> int:
    return p.evaluate("() => [...document.querySelectorAll('button, label.button, .g-choice')].filter(e => e.offsetWidth || e.offsetHeight).length")


def test_first_time_coordinator_plans_and_runs_a_dinner(page, tmp_path):
    p = page
    assert visible_buttons(p) <= 5, "the first screen offers a few clear choices"
    assert jargon(p) == []
    button(p, "More").click()
    assert "Full planner (every option)" in words(p)
    button(p, "More").click()

    p.get_by_text("New event", exact=True).click()
    p.get_by_label("Event name").fill("Transfer Admit Dinner")
    p.get_by_label("Rounds").select_option("3")
    p.get_by_label("Doors open at").fill("6:00 PM")
    button(p, "Next: alumni").click()

    alumni = "Alum's name\tTopic\tCan talk about\n" + "\n".join(
        f"Alum {c}\t{t}\t{f}" for c, t, f in [
            ("A", "Medicine", "medicine; biology"), ("B", "Law", "law; policy"), ("C", "Tech", "software; data"),
            ("D", "Art", "art; design"), ("E", "Finance", "finance; economics"), ("F", "Teaching", "education; history")])
    paste(p, p.locator('[data-kind="hosts"] .g-row.new input').first, alumni)
    assert "Added 6 alumni from your spreadsheet." in words(p)
    p.locator(".g-settings-line").nth(3).get_by_role("button").click()
    p.get_by_label("Hosts from round").select_option("2")
    assert "arrives for round 2" in words(p)
    assert jargon(p) == []
    button(p, "Next: fams").click()

    fams = "\n".join(f"{i}\tFam {n}\t{f}" for i, (n, f) in enumerate(
        [("Red", "biology"), ("Blue", "law"), ("Gold", "data"), ("Teal", "design"), ("Pink", "economics"), ("Gray", "history")], start=1))
    paste(p, p.locator('[data-kind="fams"] .g-row.new input').first, fams)
    assert "Added 6 fams" in words(p)
    button(p, "Make the schedule").click()
    p.wait_for_selector("text=pairings share an interest")
    assert "No fam meets the same alum twice." in words(p)
    assert jargon(p) == []
    art = p.locator(".g-grid tbody tr", has_text="Fam Red").locator("td").nth(0)
    assert "Alum D" not in art.inner_text(), "Alum D only arrives for round 2"

    # Swap two alumni in round 3 by tapping their names.
    rounds_1_2 = [p.locator(".g-grid tbody tr").locator(f"td:nth-of-type({c}) .g-name").all_inner_texts() for c in (1, 2)]
    cells = p.locator(".g-grid tbody tr").locator("td:nth-of-type(3) .g-name")
    first, second = cells.nth(0).inner_text(), cells.nth(1).inner_text()
    cells.nth(0).click()
    cells.nth(1).click()
    p.wait_for_selector("text=placed by hand")
    cells = p.locator(".g-grid tbody tr").locator("td:nth-of-type(3) .g-name")
    assert (cells.nth(0).inner_text(), cells.nth(1).inner_text()) == (second, first)
    after = [p.locator(".g-grid tbody tr").locator(f"td:nth-of-type({c}) .g-name").all_inner_texts() for c in (1, 2)]
    # Rounds 1 and 2 change only where the swap forces it (no fam may meet an alum twice), and every such change is listed.
    p.locator(".msg.info details summary").click() if p.locator(".msg.info details").count() else None
    report = p.inner_text(".msg.info")
    for c, (old, new) in enumerate(zip(rounds_1_2, after), start=1):
        for a, b in zip(old, new):
            if a != b and b != "No alum":
                assert f"{b} " in report or f"{b}:" in report, (c, a, b)
    button(p, "Undo my moves").click()
    p.wait_for_function("() => !document.body.innerText.includes('placed by hand')")

    button(p, "Next: print").click()
    with p.expect_popup() as pop:
        p.locator(".g-print li", has_text="Seating chart").get_by_role("button").click()
    pop.value.close()
    assert "Recorded what you printed" in words(p)
    button(p, "Next: the night").click()
    p.get_by_text("Open night mode", exact=True).click()
    p.wait_for_selector("text=Round 1 of 3")
    assert visible_buttons(p) <= 25, "night mode starts status-first"
    button(p, "Back to planning").click()
    p.wait_for_selector("text=Next: next year")
    button(p, "Next: next year").click()
    p.get_by_label("Notes for next year").fill("Table 7 is by the kitchen.")
    with p.expect_download() as d:
        button(p, "Download the hand-off folder").click()
    assert d.value.suggested_filename.endswith("handoff.zip")

    # A reload comes back to where the coordinator was.
    p.reload()
    p.wait_for_selector("text=Next year")
    assert "Transfer Admit Dinner" in p.inner_text(".g-title")


def test_the_example_is_a_sandbox(page):
    p = page
    p.get_by_text("Try it with an example").click()
    p.wait_for_selector("text=pairings share an interest")
    assert "Practice: nothing is kept" in p.inner_text(".g-head")
    button(p, "End practice").click()
    p.wait_for_selector("text=Plan a rotation dinner")
    assert "Continue" not in words(p)


def test_a_swap_that_breaks_a_setting_changes_nothing(page):
    p = page
    p.get_by_text("Try it with an example").click()
    p.wait_for_selector("text=pairings share an interest")
    button(p, "Back").click()
    button(p, "Back").click()
    # Physician (MD), Alum A, must never meet Bio & Chem.
    p.locator(".g-settings-line").first.get_by_role("button").click()
    p.locator(".g-settings select").nth(3).select_option("Bio & Chem")
    assert "never meets Bio & Chem" in words(p)
    button(p, "Next: fams").click()
    button(p, "Make the schedule").click()
    p.wait_for_selector("text=pairings share an interest")
    grid = p.locator(".g-grid tbody tr")
    alum_a = [i for i in range(10) if grid.nth(i).locator("td:nth-of-type(1) .g-name").inner_text() == "Alum A"][0]
    before = p.inner_text(".g-grid")
    grid.nth(alum_a).locator("td:nth-of-type(1) .g-name").click()
    grid.filter(has_text="Bio & Chem").locator("td:nth-of-type(1) .g-name").click()
    p.wait_for_selector("text=doesn't fit the settings")
    assert p.inner_text(".g-grid") == before
    assert "You changed something" not in words(p)
