"""A first-time coordinator in the coordinator app, with no documentation.

Set up (paste alumni and fams from a spreadsheet, with title rows), Schedule
(a room plan; swaps only in Adjust), Print (what to print and why), Run (a
separate mode with one button and "Something came up"), and Wrap up. Every
screen must be in event words and stay small.
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

COORD_JARGON = JARGON + [r"\bscore\b", r"\btags?\b", r"\bhost table\b", r"\bpairing rule\b", r"\bpenalty\b", r"\bobjective\b", r"\boptimi[sz]", r"\bsolver\b", r"\bnight mode\b"]

ALUMNI = "Full Name\tEmail\tIndustry\tTopics they can discuss\n" + "\n".join(
    f"Alum {c}\t{c.lower()}@example.com\t{ind}\t{t}" for c, ind, t in [
        ("A", "Health", "medicine, biology"), ("B", "Law", "law, policy"), ("C", "Tech", "software, data"),
        ("D", "Arts", "art, design"), ("E", "Finance", "finance, economics"), ("F", "Law", "education, history")])
FAMS = "Fam\tMajors in this fam\n" + "\n".join(
    f"Fam {n}\t{f}" for n, f in [("Red", "biology"), ("Blue", "law"), ("Gold", "data"), ("Teal", "design"), ("Pink", "economics"), ("Gray", "history")])


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
    return [j for j in COORD_JARGON if re.search(j, words(p), re.IGNORECASE)]


def paste(p, label: str, text: str) -> None:
    p.locator("h1").click()
    p.evaluate("t => navigator.clipboard.writeText(t)", text)
    p.get_by_label(label).click()
    p.keyboard.press("ControlOrMeta+V")
    p.wait_for_timeout(150)


def visible_controls(p) -> int:
    return p.evaluate("() => [...document.querySelectorAll('button, label.c-button, label.c-choice, select, input:not([type=file]), textarea')].filter(e => e.offsetWidth || e.offsetHeight).length")


def test_first_time_coordinator_plans_and_runs_a_dinner(page):
    p = page
    assert visible_controls(p) <= 5, "the first screen offers a few clear choices"
    assert jargon(p) == []
    p.get_by_role("button", name="Event menu").click()
    assert "Full planner" not in words(p), "the full planner is only at #full"
    p.keyboard.press("Escape")

    p.get_by_text("Start a dinner").click()
    assert [t.split(",")[0] for t in p.locator(".c-tab").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")] == ["Set up", "Schedule", "Print", "Run"]
    p.get_by_label("Name").fill("Transfer Admit Dinner")
    button(p, "Next: your alumni").click()
    paste(p, "Paste or type your alumni", ALUMNI)
    assert "Added 6 alumni." in words(p)
    # Two alumni share the field "Law", so they host one table together and move as a pair.
    assert "host one table together: Alum B & Alum F (Law)" in words(p)
    assert "6 alumni at 5 tables" in p.inner_text('[data-card="hosts"]')
    p.locator('[data-card="hosts"] .c-card-head').click()
    assert p.locator('[data-kind="hosts"] li.pair').count() == 1
    p.get_by_role("button", name="More options").first.click()
    p.get_by_label("Choose an alum").select_option(label="Alum D")
    p.get_by_label("Alum D is here from round").select_option("2")
    assert "arrives for round 2" in words(p)
    paste(p, "Paste or type your fams", FAMS)
    assert "Added 6 fams." in words(p)
    p.locator('[data-card="fams"] .c-card-head').click()
    assert "first row looked like column titles" in words(p), "a title row is skipped, and said so"
    assert p.locator('[data-kind="fams"] li').count() == 6
    assert jargon(p) == []

    button(p, "Make the schedule").click()
    p.wait_for_selector(".c-plan")
    assert "fam meets" in words(p) and "a different one each round" in words(p)
    assert jargon(p) == []
    assert p.locator(".c-seat-button").count() == 0, "the schedule is calm until Adjust"
    assert "Alum D" not in " ".join(p.locator('.c-seat[data-round="1"]').all_inner_texts()), "Alum D arrives for round 2"

    # Swap two alumni in round 3 in Adjust.
    button(p, "Adjust").click()
    seats = p.locator('.c-seat-button[data-round="3"]')
    a, b = seats.nth(0).locator(".c-seat-name").inner_text(), seats.nth(1).locator(".c-seat-name").inner_text()
    seats.nth(0).click()
    assert "Now tap where they should go in round 3" in words(p)
    seats.nth(1).click()
    p.wait_for_selector("text=placed by hand")
    seats = p.locator('.c-seat-button[data-round="3"]')
    assert (seats.nth(0).locator(".c-seat-name").inner_text(), seats.nth(1).locator(".c-seat-name").inner_text()) == (b, a)
    button(p, "Undo my changes").click()
    p.wait_for_function("() => !document.body.innerText.includes('placed by hand')")
    button(p, "Done adjusting").click()

    button(p, "Looks good: print").click()
    assert p.locator(".c-docs li").count() == 4
    assert "pages in all" in words(p)
    with p.expect_popup() as pop:
        button(p, "Print everything").click()
    everything = pop.value
    everything.wait_for_load_state()
    assert everything.locator(".part").count() == 4
    everything.close()
    assert "You are ready for the event." in words(p)

    button(p, "Next: run the event").click()
    assert p.locator(".c-tabs").count() == 0, "Run is its own mode"
    assert visible_controls(p) <= 7, "the night shows the round, one button, and Something came up"
    assert jargon(p) == []
    button(p, "Start round 1").click()
    # The clock counts down to the second.
    first = p.inner_text("#c-clock-num")
    assert re.fullmatch(r"\d+:\d\d", first) and "left" in words(p)
    p.wait_for_timeout(2100)
    assert p.inner_text("#c-clock-num") != first
    button(p, "Something came up").click()
    button(p, "An alum left or didn't come").click()
    p.get_by_label("Alum who left").select_option(label="Alum B")
    p.get_by_label("Misses from round").select_option("2")
    button(p, "Work out who moves").click()
    p.wait_for_selector(".c-tell, .c-msg.ok")
    # Alum B was half of a pair: Alum F keeps the table, so nobody moves.
    assert "Nobody else moves" in words(p)
    if p.locator(".c-tell").count():
        assert "Everyone else stays where their card says." in words(p)
        p.locator(".c-tell input[type=checkbox]").first.check()
        assert p.locator(".c-tell li.told").count() == 1
    button(p, "See who is at each table").click()
    p.get_by_role("button", name="Round 2", exact=True).click()
    seated = " ".join(p.locator(".c-where .who").all_inner_texts())
    assert "Alum B" not in seated and "Alum F" in seated

    p.get_by_role("button", name="Night menu").click()
    button(p, "Wrap up").click()
    p.get_by_label("What would you change next year?").fill("Table 7 is by the kitchen.")
    with p.expect_download() as d:
        button(p, "Save for next year").click()
    assert d.value.suggested_filename.endswith("handoff.zip")

    # A reload comes back to where the coordinator was.
    p.reload()
    p.wait_for_selector("text=What would you change next year?")
    assert "Transfer Admit Dinner" in p.inner_text(".c-title")


def test_the_example_is_a_sandbox(page):
    p = page
    p.get_by_text("Try an example").click()
    p.wait_for_selector(".c-plan")
    assert "Practice" in p.inner_text(".c-top")
    p.locator(".c-top").get_by_role("button", name="End practice").click()
    p.wait_for_selector("text=Plan your rotation dinner")
    assert "Continue" not in words(p)


def test_a_swap_that_breaks_a_setting_is_refused_up_front(page):
    p = page
    p.get_by_text("Try an example").click()
    p.wait_for_selector(".c-plan")
    p.locator(".c-tab", has_text="Set up").click()
    p.locator('[data-card="hosts"] .c-card-head').click()
    p.get_by_role("button", name="More options").first.click()
    p.get_by_label("Choose an alum").select_option(label="Alum A")
    p.get_by_label("Never meets, for Alum A").select_option("Bio & Chem")
    assert "never meets Bio & Chem" in words(p)
    button(p, "Update the schedule").click()
    p.wait_for_selector(".c-plan")
    button(p, "Adjust").click()
    alum_a = p.locator('.c-seat-button[data-round="1"]', has_text="Alum A")
    bio = p.locator(".c-plan-row", has_text="Bio & Chem").locator('.c-seat-button[data-round="1"]')
    before = p.inner_text(".c-plan")
    alum_a.click()
    assert bio.get_attribute("aria-disabled") == "true"
    assert "Not possible: Alum A is set to never meet Bio & Chem." in bio.get_attribute("aria-label")
    bio.click(force=True)
    assert "Alum A is set to never meet Bio & Chem." in words(p)
    assert p.inner_text(".c-plan").replace("\n", "") .count("Alum") == before.replace("\n", "").count("Alum")


def test_the_full_planner_is_at_its_own_address(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        p = browser.new_page()
        p.goto(url + "#full")
        p.wait_for_selector("#sidebar")
        button(p, "Back to the guided planner").click()
        p.wait_for_selector("main.coord")
        browser.close()


def test_a_move_already_passed_on_is_taken_back_out_loud(page):
    # Someone is told to move; a later change undoes that move. They must be told again.
    p = page
    p.get_by_text("Try an example").click()
    p.wait_for_selector(".c-plan")
    button(p, "Looks good: print").click()
    with p.expect_popup() as pop:
        button(p, "Print everything").click()
    pop.value.close()
    button(p, "Next: run the event").click()
    button(p, "Start round 1").click()
    button(p, "Something came up").click()
    button(p, "An alum left or didn't come").click()
    p.get_by_label("Alum who left").select_option(label="Alum A")
    p.get_by_label("Misses from round").select_option("2")
    button(p, "Work out who moves").click()
    p.wait_for_selector(".c-tell")
    for box in p.locator(".c-tell input[type=checkbox]").all():
        box.check()
    assert "Everyone has been told" in words(p)
    button(p, "Something came up").click()
    button(p, "An alum arrived late, or someone new came").click()
    p.get_by_label("Alum who arrived").select_option(label="Alum A")
    p.get_by_label("Hosts from round").select_option("2")
    button(p, "Work out who moves").click()
    p.wait_for_selector(".c-tell")
    assert "change of plan for round 2" in words(p)


def test_an_old_full_planner_choice_still_opens_the_coordinator_app(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context()
        ctx.add_init_script("localStorage.setItem('rotation-optimizer:ui', 'full')")
        p = ctx.new_page()
        p.goto(url)
        p.wait_for_selector("text=Plan your rotation dinner")
        assert p.locator("#sidebar").count() == 0
        browser.close()


def test_a_pair_can_split_and_two_alumni_can_pair(page):
    p = page
    p.get_by_text("Start a dinner").click()
    p.get_by_label("Name").fill("Spring Dinner")
    button(p, "Next: your alumni").click()
    paste(p, "Paste or type your alumni", ALUMNI)
    p.locator('[data-card="hosts"] .c-card-head').click()
    assert p.locator('[data-kind="hosts"] li').count() == 5
    p.get_by_role("button", name="Split Alum B & Alum F so each hosts alone").click()
    assert p.locator('[data-kind="hosts"] li').count() == 6
    assert p.locator('[data-kind="hosts"] li.pair').count() == 0
    p.get_by_role("button", name="More options").first.click()
    p.get_by_label("First alum of the pair").select_option(label="Alum A")
    p.get_by_label("Second alum of the pair").select_option(label="Alum C")
    button(p, "Pair them").click()
    assert "Alum A & Alum C now host one table together." in words(p)
    assert p.locator('[data-kind="hosts"] li.pair').count() == 1

    # Home becomes the event, with one next step.
    p.get_by_role("button", name="Event menu").click()
    button(p, "Start another dinner or see the example").click()
    assert p.locator("h1").inner_text() == "Spring Dinner"
    assert p.locator(".c-steps li").count() == 4
    button(p, "Next: add your alumni and fams").click()
    p.wait_for_selector("text=Set up")


def tour_text(p) -> str:
    return p.inner_text(".c-tour")


def test_the_tour_walks_an_example_dinner_and_remembers_where_it_was(page):
    p = page
    p.get_by_role("button", name="Take the 2-minute tour").click()
    assert "Here's an example alumni dinner." in tour_text(p)
    assert "Welcome to Spring Alumni Dinner" in tour_text(p)
    seen = []
    for step in range(1, 8):
        p.wait_for_selector(f'.c-tour-scene[data-step="{step}"]')
        if step == 3:
            p.wait_for_selector("text=Schedule ready.")
        if step == 4:
            p.wait_for_selector(".c-tour-matches")
        if step == 6:
            assert "Who is where, round 1" in tour_text(p)
            clock = p.inner_text(".c-tour-ring span")
            p.wait_for_timeout(1100)
            assert p.inner_text(".c-tour-ring span") != clock, "the phone's clock ticks"
            p.locator('[data-k="tour-end-round"]').click()
            assert "Who is where, round 2" in tour_text(p)
        text = tour_text(p)
        seen.append(text)
        assert [j for j in COORD_JARGON if re.search(j, text, re.IGNORECASE)] == [], f"step {step}"
        if step == 5:
            # Leave half way; the tour picks up at the same step.
            p.keyboard.press("Escape")
            assert p.locator(".c-tour").count() == 0
            p.reload()
            p.get_by_role("button", name=re.compile("Continue the tour")).click()
            p.wait_for_selector('.c-tour-scene[data-step="5"]')
            button(p, "Back").click()
            p.wait_for_selector('.c-tour-scene[data-step="4"]')
            p.locator('[data-k="tour-next"]').click()
        if step < 7:
            p.locator('[data-k="tour-next"]').click()
    assert "meets" in seen[3] and "because they share" in seen[3]
    assert not any("What if" in x or "couldn't make" in x for x in seen), "no made-up cancellations"
    assert "Event complete" in seen[6]
    button(p, "Plan my dinner").click()
    assert p.locator(".c-tour").count() == 0
    p.wait_for_selector("text=Your dinner")
    # Once seen, the tour is a quieter choice on the first screen.
    p.get_by_role("button", name="Event menu").click()
    button(p, "Start another dinner or see the example").click()
    assert p.locator(".c-choice.primary", has_text="Start a dinner").count() == 1


def test_the_tour_uses_the_coordinators_own_event(page):
    p = page
    p.get_by_text("Start a dinner").click()
    p.get_by_label("Name").fill("Transfer Admit Dinner")
    button(p, "Next: your alumni").click()
    paste(p, "Paste or type your alumni", ALUMNI)
    paste(p, "Paste or type your fams", FAMS)
    p.get_by_role("button", name="Event menu").click()
    button(p, "Take the 2-minute tour").click()
    assert "Let's walk through your event." in tour_text(p)
    assert "Welcome to Transfer Admit Dinner" in tour_text(p)
    p.locator('[data-k="tour-next"]').click()
    assert "Alum A" in tour_text(p) and "Fam Red" in tour_text(p)
    p.locator('[data-k="tour-next"]').click()
    p.wait_for_selector("text=Schedule ready.")
    p.locator('[data-k="tour-next"]').click()
    p.wait_for_selector(".c-tour-matches")
    assert re.search(r"meets Alum [A-F]", tour_text(p))
    button(p, "Skip tour").click()
    assert p.locator(".c-tour").count() == 0
    assert ev_plan_is_untouched(p)


def ev_plan_is_untouched(p) -> bool:
    # The tour plans on a copy: the coordinator's own event still has no schedule.
    return p.locator(".c-tab", has_text="Print").get_attribute("disabled") is not None


# A seating chart as coordinators keep it in a Google Doc, with invented people.
CHART_HTML = """<table><tr><td><p>Fam Table</p></td><td><p>Round 1 (alums)</p></td><td><p>Round 2 (alums)</p></td></tr>
<tr><td><p>Table 1</p><p>Fam 6 (PoliSci/Comm)</p></td><td><p>Ann Park</p></td><td><p>Bo Lin</p></td></tr>
<tr><td><p>Table 2</p><p>Fam 3 (Cog Sci/Math)</p></td><td><p>Cy Ruiz + Di Wu</p></td><td><p>Ann Park</p></td></tr>
<tr><td><p>Table 3</p><p>Fam 10 (Bio/Chem)</p></td><td><p>Bo Lin</p></td><td><p>Cy Ruiz + Di Wu</p></td></tr></table>"""
ALUMNI_LIST = "Ann Park: ann@example.com\nNonprofit consulting and education reform\nBo Lin: bo@example.com\nPracticing internist\nCy Ruiz: cy@example.com\nSemiconductor engineer\nGus Hale: gus@example.com\nDatabase analyst"


def paste_html(p, label: str, html: str, text: str = "") -> None:
    p.get_by_label(label).evaluate(
        "(el, [html, text]) => { const d = new DataTransfer(); d.setData('text/html', html); d.setData('text/plain', text); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); }",
        [html, text])
    p.wait_for_timeout(150)


def test_a_coordinator_pastes_the_seating_chart_and_alumni_list_they_already_have(page):
    p = page
    p.get_by_text("Start a dinner").click()
    button(p, "Next: your alumni").click()
    paste_html(p, "Paste or type your alumni", CHART_HTML, "Fam Table\nRound 1")
    assert "Read your seating chart: 3 fams, 4 alumni at 3 tables (1 pair), 2 rounds." in words(p)
    p.locator('[data-card="hosts"] .c-card-head').click()
    assert "The seating from your chart is kept as you made it." in words(p)
    button(p, "Paste more alumni").click()
    paste(p, "Paste or type your alumni", ALUMNI_LIST)
    text = words(p)
    assert "Added what 3 of 4 alumni do" in text and "Not in your seating, so left out: Gus Hale." in text
    assert "@" not in p.evaluate("() => localStorage.getItem('rotation-optimizer:event')")
    button(p, "Make the schedule").click()
    p.wait_for_selector(".c-room")
    r1 = " ".join(p.locator('.c-tile[data-round="1"]').all_inner_texts())
    assert "Fam 6" in r1 and r1.index("Ann Park") < r1.index("Cy Ruiz & Di Wu") < r1.index("Bo Lin")
    p.get_by_role("button", name="Round 2", exact=True).click()
    r2 = [t.replace("\n", " ") for t in p.locator('.c-tile[data-round="2"]').all_inner_texts()]
    assert "Bo Lin" in r2[0] and "Ann Park" in r2[1] and "Cy Ruiz & Di Wu" in r2[2]
