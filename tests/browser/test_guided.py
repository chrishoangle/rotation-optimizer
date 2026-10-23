"""A first-time coordinator in the four-step planner, with no documentation.

Opens the app, starts a dinner, pastes alumni and fams from a spreadsheet,
notes one late alum, makes the schedule, swaps two alumni by tapping them,
prints everything in one go, runs the night with a cancellation, and saves
the event for next year. Every screen must be in event words, and each must
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

GUIDED_JARGON = JARGON + [r"\bscore\b", r"\btags?\b", r"\bre-plan now\b", r"\bhost table\b", r"\bpairing rule\b", r"\bweak\b", r"\bpairings\b", r"\bnight mode\b"]

ALUMNI = "\n".join(f"Alum {c}\t{t}" for c, t in [
    ("A", "medicine; biology"), ("B", "law; policy"), ("C", "software; data"),
    ("D", "art; design"), ("E", "finance; economics"), ("F", "education; history")])
FAMS = "\n".join(f"{i}\tFam {n}\t{f}" for i, (n, f) in enumerate(
    [("Red", "biology"), ("Blue", "law"), ("Gold", "data"), ("Teal", "design"), ("Pink", "economics"), ("Gray", "history")], start=1))


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
        p.wait_for_selector("text=Plan your rotation dinner")
        yield p
        assert errors == []
        browser.close()


def words(p) -> str:
    return p.inner_text("main")


def jargon(p) -> list[str]:
    return [j for j in GUIDED_JARGON if re.search(j, words(p), re.IGNORECASE)]


def paste(p, label: str, text: str) -> None:
    p.evaluate("t => navigator.clipboard.writeText(t)", text)
    p.get_by_label(label).click()
    p.keyboard.press("ControlOrMeta+V")
    p.wait_for_timeout(150)


def visible_buttons(p) -> int:
    return p.evaluate("() => [...document.querySelectorAll('button, label.button, .g-choice, select')].filter(e => e.offsetWidth || e.offsetHeight).length")


def visits(p, rnd: int):
    return p.locator(f'.g-visit[data-round="{rnd}"]')


def test_first_time_coordinator_plans_and_runs_a_dinner(page, tmp_path):
    p = page
    assert visible_buttons(p) <= 5, "the first screen offers a few clear choices"
    assert jargon(p) == []
    button(p, "More").click()
    assert "Full planner" not in words(p), "the full planner is only at #full"
    button(p, "More").click()

    p.get_by_text("Start a new dinner").click()
    assert len(p.locator(".g-step").all()) == 4
    paste(p, "Paste alumni", ALUMNI)
    assert "Added 6 alumni." in words(p)
    p.get_by_label("Alum who needs something").select_option(label="Alum D")
    p.get_by_label("Hosts from round").select_option("2")
    assert "arrives for round 2" in words(p)
    paste(p, "Paste fams", FAMS)
    assert "Added 6 fams." in words(p)
    assert jargon(p) == []
    button(p, "Make the schedule").click()
    p.wait_for_selector(".g-tables")
    assert "never the same one twice" in words(p)
    assert jargon(p) == []
    assert "Alum D" not in " ".join(visits(p, 1).all_inner_texts()), "Alum D only arrives for round 2"

    # Swap two alumni in round 3 by tapping them.
    before = {r: visits(p, r).all_inner_texts() for r in (1, 2)}
    first, second = visits(p, 3).nth(0), visits(p, 3).nth(1)
    a, b = first.locator(".g-name").inner_text(), second.locator(".g-name").inner_text()
    first.click()
    assert "picked for round 3" in words(p)
    second.click()
    p.wait_for_selector("text=placed by hand")
    assert (visits(p, 3).nth(0).locator(".g-name").inner_text(), visits(p, 3).nth(1).locator(".g-name").inner_text()) == (b, a)
    # Other rounds change only where the swap forces it, and every such change is listed.
    if p.locator(".msg.info details").count():
        p.locator(".msg.info details summary").click()
    report = p.inner_text(".msg.info") if p.locator(".msg.info").count() else ""
    for r in (1, 2):
        for old, new in zip(before[r], visits(p, r).all_inner_texts()):
            name = new.split("\n")[1] if "\n" in new else new
            if old != new and "No alum" not in name:
                assert f"{name}:" in report or f"{name} " in report, (r, old, new)
    button(p, "Undo my moves").click()
    p.wait_for_function("() => !document.body.innerText.includes('placed by hand')")

    button(p, "Next: print").click()
    p.get_by_label("Event name").fill("Transfer Admit Dinner")
    p.get_by_label("Doors open at").fill("6:00 PM")
    with p.expect_popup() as pop:
        button(p, "Print everything").click()
    everything = pop.value
    everything.wait_for_load_state()
    assert everything.locator(".part").count() == 4
    everything.close()
    assert "Printed." in words(p)

    button(p, "Next: run the event").click()
    assert visible_buttons(p) <= 14, "the night starts with the round and one change button"
    assert jargon(p) == []
    button(p, "Start round 1").click()
    assert "minutes left" in words(p)
    button(p, "Someone changed?").click()
    p.get_by_label("Alum who left").select_option(label="Alum B")
    p.get_by_label("Misses from round").select_option("2")
    button(p, "Re-plan").click()
    p.wait_for_selector("text=Tell these people")
    button(p, "See round 2").click()
    assert "Alum B" not in " ".join(p.locator(".g-where .who").all_inner_texts())
    box = p.locator(".tell input[type=checkbox]").first
    box.check()
    assert p.locator(".tell li.told").count() == 1

    button(p, "More").click()
    p.get_by_role("menuitem", name="Save for next year").click()
    p.get_by_label("Notes for next year").fill("Table 7 is by the kitchen.")
    with p.expect_download() as d:
        button(p, "Download the hand-off folder").click()
    assert d.value.suggested_filename.endswith("handoff.zip")

    # A reload comes back to where the coordinator was.
    p.reload()
    p.wait_for_selector("text=Save for next year")
    assert "Transfer Admit Dinner" in p.inner_text(".g-title")


def test_the_example_is_a_sandbox(page):
    p = page
    p.get_by_text("See an example").click()
    p.wait_for_selector(".g-tables")
    assert "Practice, nothing is kept" in p.inner_text(".g-head")
    p.locator(".g-pill.practice").get_by_role("button", name="End").click()
    p.wait_for_selector("text=Plan your rotation dinner")
    assert "Continue" not in words(p)


def test_a_swap_that_breaks_a_setting_is_refused_up_front(page):
    p = page
    p.get_by_text("See an example").click()
    p.wait_for_selector(".g-tables")
    button(p, "Back").click()
    p.get_by_label("Alum who needs something").select_option(label="Alum A")
    p.locator(".g-rare summary").click()
    p.get_by_label("Never meets").select_option("Bio & Chem")
    assert "never meets Bio & Chem" in words(p)
    button(p, "Make the schedule").click()
    p.wait_for_selector(".g-tables")
    alum_a = visits(p, 1).filter(has_text="Alum A")
    bio = p.locator(".g-table", has_text="Bio & Chem").locator('.g-visit[data-round="1"]')
    before = p.inner_text(".g-tables")
    alum_a.click()
    # The swap is refused before it is tried: the seat is greyed out and says why.
    assert bio.is_disabled()
    assert bio.get_attribute("title") == "Alum A is set to never meet Bio & Chem."
    button(p, "Cancel").click()
    assert p.inner_text(".g-tables") == before


def test_the_full_planner_is_at_its_own_address(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        p = browser.new_page()
        p.goto(url + "#full")
        p.wait_for_selector("#sidebar")
        button(p, "Back to the guided planner").click()
        p.wait_for_selector("text=Plan your rotation dinner")
        browser.close()
