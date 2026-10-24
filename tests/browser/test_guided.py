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


def add_people(p, kind: str, text: str = "", html: str = "") -> None:
    """Add alumni or fams the way a coordinator does: + Add, paste (or type), then Add."""
    p.locator(f'[data-k="add-{kind}"]').click()
    box = p.locator('[data-k="sheet-box"]')
    if html:
        box.evaluate(
            "(el, [html, text]) => { const d = new DataTransfer(); d.setData('text/html', html); d.setData('text/plain', text); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); }",
            [html, text])
    else:
        p.evaluate("t => navigator.clipboard.writeText(t)", text)
        box.click()
        p.keyboard.press("ControlOrMeta+V")
    p.wait_for_timeout(150)
    p.locator('[data-k="add-commit"]').click()
    p.wait_for_timeout(150)


def type_people(p, kind: str, text: str) -> None:
    p.locator(f'[data-k="add-{kind}"]').click()
    p.locator('[data-k="sheet-box"]').fill(text)
    p.locator('[data-k="add-commit"]').click()


def name_dinner(p, name: str) -> None:
    p.locator('[data-k="line-name"]').click()
    p.get_by_label("Name", exact=True).fill(name)
    p.locator('[data-k="line-name"]').click()


def open_person(p, who: str) -> None:
    p.locator(".c-person", has_text=who).first.click()


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
    assert [t.split(",")[0] for t in p.locator(".c-tab").evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")] == ["Your dinner", "Print", "Run"]
    # Two actions, in the coordinator's words: no paste, file, or format in sight.
    assert p.locator('[data-k="add-hosts"]').inner_text() == "+ Add alumni" and p.locator('[data-k="add-fams"]').inner_text() == "+ Add fams"
    assert not re.search(r"\bpaste\b|\bcsv\b|\bcolumns?\b|\bimport", words(p), re.IGNORECASE)
    name_dinner(p, "Transfer Admit Dinner")
    add_people(p, "hosts", ALUMNI)
    assert "Added 6 alumni." in words(p)
    # Two alumni share the field "Law", so they host one table together and move as a pair.
    assert "host one table together: Alum B & Alum F (Law)" in words(p)
    assert "6 alumni at 5 tables" in p.inner_text('[data-card="hosts"]')
    assert p.locator('[data-kind="hosts"] li.pair').count() == 1
    # Special arrangements live on the person.
    open_person(p, "Alum D")
    p.get_by_label("Alum D is here from round").select_option("2")
    button(p, "Done").click()
    assert "arrives for round 2" in words(p)
    add_people(p, "fams", FAMS)
    # With both lists in, the room draws itself right beside the guest list: no button, no other page.
    p.wait_for_selector(".c-dinner-room .c-room")
    assert "A title row was left out" in p.inner_text('[data-card="fams"]'), "a title row is skipped, and said so"
    assert p.locator('[data-kind="fams"] li').count() == 6
    assert jargon(p) == []
    p.locator(".c-tab", has_text="Your dinner").click()
    p.wait_for_selector(".c-plan")
    assert "fam meets" in words(p) and "a different one each round" in words(p)
    assert jargon(p) == []
    assert p.locator(".c-seat-button").count() == 0, "the schedule is calm until Adjust"
    assert "Alum D" not in " ".join(p.locator('.c-seat[data-round="1"]').all_inner_texts()), "Alum D arrives for round 2"

    # Swap two alumni in round 3 in Adjust.
    button(p, "Adjust").click()
    p.get_by_role("button", name="Round 3", exact=True).click()
    seats = p.locator('.c-seat-button[data-round="3"]')
    a, b = seats.nth(0).locator(".c-seat-name").inner_text(), seats.nth(1).locator(".c-seat-name").inner_text()
    seats.nth(0).click()
    assert "Now tap where they should go in round 3" in words(p)
    seats.nth(1).click()
    p.wait_for_selector("text=set by hand")
    assert p.locator(".c-tile.moved").count() >= 1, "the swapped tables are marked on the room"
    seats = p.locator('.c-seat-button[data-round="3"]')
    assert (seats.nth(0).locator(".c-seat-name").inner_text(), seats.nth(1).locator(".c-seat-name").inner_text()) == (b, a)
    button(p, "Undo my changes").click()
    p.wait_for_function("() => !document.body.innerText.includes('set by hand')")
    button(p, "Done adjusting").click()

    button(p, "Looks good: print").click()
    assert p.locator(".c-docs li").count() == 4
    assert re.search(r"about \d+ pages", words(p))
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
    assert "Who is where, round 1" in p.inner_text(".c-where-wrap"), "who is where is always on the Run screen"
    p.locator('[data-k="where-next"]').click()
    seated = " ".join(p.locator(".c-where .who").all_inner_texts())
    assert "Alum B" not in seated and "Alum F" in seated

    p.get_by_role("button", name="Night menu").click()
    button(p, "Wrap up").click()
    p.get_by_label("What would you change next year?").fill("Table 7 is by the kitchen.")
    with p.expect_download() as d:
        button(p, "Save for next year").click()
    assert d.value.suggested_filename.endswith("handoff.zip")

    # Opening the app again starts on the event's home page, with the next step.
    p.reload()
    p.wait_for_selector(".c-hero")
    assert p.locator("h1").inner_text() == "Transfer Admit Dinner"
    assert p.locator('[data-k="next-step"]').count() == 1


def test_the_example_is_a_sandbox(page):
    p = page
    p.get_by_text("See the STEW 2026 dinner").click()
    p.wait_for_selector(".c-plan")
    assert "Example: nothing is saved" in words(p)
    p.locator('[data-k="exit-example"]').first.click()
    p.wait_for_selector("text=Plan your rotation dinner")
    assert "Continue" not in words(p)


def test_a_swap_that_breaks_a_setting_is_refused_up_front(page):
    p = page
    p.get_by_text("See the STEW 2026 dinner").click()
    p.wait_for_selector(".c-plan")
    p.locator(".c-tab", has_text="Your dinner").click()
    # The example is the real STEW 2026 dinner: Kenneth Tran hosts Fam 6 in round 1.
    open_person(p, "Kenneth Tran")
    p.get_by_label("Never meets, for Kenneth Tran").select_option("Fam 3")
    button(p, "Done").click()
    assert "never meets Fam 3" in words(p)
    # The room brings itself up to date.
    p.locator(".c-tab", has_text="Your dinner").click()
    p.wait_for_selector(".c-plan")
    button(p, "Adjust").click()
    kenneth = p.locator('.c-seat-button[data-round="1"]', has_text="Kenneth Tran")
    fam3 = p.locator('.c-seat-button[data-round="1"]', has_text="Fam 3")
    before = p.inner_text(".c-plan")
    kenneth.click()
    assert fam3.get_attribute("aria-disabled") == "true"
    assert "Not possible: Kenneth Tran is set to never meet Fam 3." in fam3.get_attribute("aria-label")
    fam3.click(force=True)
    assert "Kenneth Tran is set to never meet Fam 3." in words(p)
    button(p, "Done adjusting").click()
    button(p, "Adjust").click()
    assert p.inner_text(".c-plan") == before, "nothing moved"


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
    p.get_by_text("See the STEW 2026 dinner").click()
    p.wait_for_selector(".c-plan")
    button(p, "Looks good: print").click()
    with p.expect_popup() as pop:
        button(p, "Print everything").click()
    pop.value.close()
    button(p, "Next: run the event").click()
    button(p, "Start round 1").click()
    # Leaving the night mid-round asks first.
    p.locator('[data-k="run-back"]').click()
    assert "A round is running." in words(p)
    button(p, "Stay").click()
    assert p.locator(".c-timer").count() == 1
    button(p, "Something came up").click()
    button(p, "An alum left or didn't come").click()
    p.get_by_label("Alum who left").select_option(label="Kenneth Tran")
    p.get_by_label("Misses from round").select_option("2")
    button(p, "Work out who moves").click()
    p.wait_for_selector(".c-tell")
    for box in p.locator(".c-tell input[type=checkbox]").all():
        box.check()
    assert "Everyone has been told" in words(p)
    button(p, "Something came up").click()
    button(p, "An alum arrived late, or someone new came").click()
    p.get_by_label("Alum who arrived").select_option(label="Kenneth Tran")
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
    name_dinner(p, "Spring Dinner")
    add_people(p, "hosts", ALUMNI)
    assert p.locator('[data-kind="hosts"] li').count() == 5
    # A pair splits from the pair itself, and two alumni pair from either one.
    open_person(p, "Alum B & Alum F")
    button(p, "Host alone").click()
    assert p.locator('[data-kind="hosts"] li').count() == 6
    assert p.locator('[data-kind="hosts"] li.pair').count() == 0
    open_person(p, "Alum A")
    p.get_by_label("Pair Alum A with").select_option(label="Alum C")
    button(p, "Pair").click()
    assert "Alum A & Alum C now host one table together." in words(p)
    assert p.locator('[data-kind="hosts"] li.pair').count() == 1

    # Home becomes the event, with one next step.
    p.get_by_role("button", name="Event menu").click()
    button(p, "Home").click()
    assert p.locator("h1").inner_text() == "Spring Dinner"
    assert p.locator(".c-steps").count() == 0, "one progress system: the tabs, not a second one on Home"
    button(p, "Next: add your fams").click()
    p.wait_for_selector("text=Your dinner")


def tour_text(p) -> str:
    return p.inner_text(".c-tour")


def test_the_tour_walks_an_example_dinner_and_remembers_where_it_was(page):
    p = page
    p.get_by_role("button", name="Take the 2-minute tour").click()
    assert "Here's a real one: the STEW 2026 family dinner." in tour_text(p)
    assert "Welcome to STEW 2026 Family Dinner" in tour_text(p)
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
    button(p, "Home").click()
    assert p.locator(".c-choice.primary", has_text="Start a dinner").count() == 1


def test_the_tour_uses_the_coordinators_own_event(page):
    p = page
    p.get_by_text("Start a dinner").click()
    name_dinner(p, "Transfer Admit Dinner")
    add_people(p, "hosts", ALUMNI)
    add_people(p, "fams", FAMS)
    p.wait_for_selector(".c-room")
    assert "Added 6 fams." in words(p)
    before = saved_plan(p)
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
    assert saved_plan(p) == before, "the tour plans on a copy: the coordinator's own schedule is untouched"


def saved_plan(p) -> str:
    return p.evaluate("() => JSON.stringify(JSON.parse(localStorage.getItem('rotation-optimizer:event') || '{}').plan)")


# A seating chart as coordinators keep it in a Google Doc, with invented people.
CHART_HTML = """<table><tr><td><p>Fam Table</p></td><td><p>Round 1 (alums)</p></td><td><p>Round 2 (alums)</p></td></tr>
<tr><td><p>Table 1</p><p>Fam 6 (PoliSci/Comm)</p></td><td><p>Ann Park</p></td><td><p>Bo Lin</p></td></tr>
<tr><td><p>Table 2</p><p>Fam 3 (Cog Sci/Math)</p></td><td><p>Cy Ruiz + Di Wu</p></td><td><p>Ann Park</p></td></tr>
<tr><td><p>Table 3</p><p>Fam 10 (Bio/Chem)</p></td><td><p>Bo Lin</p></td><td><p>Cy Ruiz + Di Wu</p></td></tr></table>"""
ALUMNI_LIST = "Ann Park: ann@example.com\nNonprofit consulting and education reform\nBo Lin: bo@example.com\nPracticing internist\nCy Ruiz: cy@example.com\nSemiconductor engineer\nGus Hale: gus@example.com\nDatabase analyst"


def test_a_coordinator_pastes_the_seating_chart_and_alumni_list_they_already_have(page):
    p = page
    p.get_by_text("Start a dinner").click()
    # The Add alumni box reads a seating chart too, shows what it read before adding, and fills both lists.
    p.locator('[data-k="add-hosts"]').click()
    p.locator('[data-k="sheet-box"]').evaluate(
        "(el, [html, text]) => { const d = new DataTransfer(); d.setData('text/html', html); d.setData('text/plain', text); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); }",
        [CHART_HTML, "Fam Table\nRound 1"])
    assert "Your seating chart: 3 fams and 4 alumni at 3 tables" in p.inner_text(".c-sheet-read")
    assert p.inner_text('[data-k="add-commit"]') == "Add this seating chart"
    p.locator('[data-k="add-commit"]').click()
    # A chart holds both lists, so the room draws itself and the guest list says what it read.
    p.wait_for_selector(".c-room")
    assert "Read your seating chart: 3 fams, 4 alumni at 3 tables (1 pair), 2 rounds." in p.inner_text('[data-card="hosts"]')
    assert "The seating from your chart is kept." in words(p)
    add_people(p, "hosts", ALUMNI_LIST)
    text = words(p)
    assert "Added what 3 of 4 alumni do" in text and "Not in your seating, so left out: Gus Hale." in text
    assert "@" not in p.evaluate("() => localStorage.getItem('rotation-optimizer:event')")
    # The room brings itself up to date with the new interests.
    p.locator(".c-tab", has_text="Your dinner").click()
    p.wait_for_selector(".c-room")
    r1 = " ".join(p.locator('.c-tile[data-round="1"]').all_inner_texts())
    assert "Fam 6" in r1 and r1.index("Ann Park") < r1.index("Cy Ruiz & Di Wu") < r1.index("Bo Lin")
    p.get_by_role("button", name="Round 2", exact=True).click()
    r2 = [t.replace("\n", " ") for t in p.locator('.c-tile[data-round="2"]').all_inner_texts()]
    assert "Bo Lin" in r2[0] and "Ann Park" in r2[1] and "Cy Ruiz & Di Wu" in r2[2]


def test_a_coordinator_always_knows_where_they_are_and_can_go_back(page):
    p = page
    # Steps that aren't ready still open, and say what they will hold and why they're empty.
    p.get_by_text("Start a dinner").click()
    assert p.locator("h1").inner_text() == "Let's plan your dinner"
    p.locator(".c-tab", has_text="Print").click()
    assert "Your printouts will appear here" in words(p)
    assert "Add your alumni and fams first" in p.locator(".c-tab", has_text="Print").get_attribute("aria-label")
    assert "Step" not in p.inner_text(".c-nextbar"), "one progress system: the tabs"
    button(p, "Go to Your dinner").click()
    assert p.locator(".c-tab.now", has_text="Your dinner").count() == 1

    # Other ways to add sit behind "More ways to add", with real examples that can be tried.
    p.locator('[data-k="add-hosts"]').click()
    assert p.locator(".c-sample").count() == 0, "examples stay folded until asked for"
    p.get_by_role("button", name="More ways to add").click()
    assert "Kenneth Tran" in p.inner_text(".c-sample")
    p.locator('[data-k="example-hosts"]').click()
    assert "Read your seating chart: 10 fams, 13 alumni at 10 tables (3 pairs), 2 rounds." in p.inner_text('[data-card="hosts"]')
    assert "Your alumni have no interests yet" in words(p), "a chart alone has no interests to match on"
    # The alumni list adds what each alum does, as interests.
    p.locator('[data-k="add-hosts"]').click()
    p.get_by_role("button", name="More ways to add").click()
    p.locator('[data-k="format-hosts-list"]').click()
    assert "Practicing internist" in p.inner_text(".c-sample")
    p.locator('[data-k="example-hosts"]').click()
    assert "Added what 13 of 13 alumni do" in words(p)
    assert "share an interest with at least one alum" in words(p)

    # Anything taken away can be put back for a few seconds.
    p.locator('[data-k="edit-hosts"]').click()
    rows = p.locator('[data-kind="hosts"] .c-grid-row:not(.head):not(.new)').count()
    p.get_by_role("button", name="Remove row 1", exact=True).click()
    assert "Removed" in p.inner_text(".c-toast")
    p.locator(".c-toast").get_by_role("button", name="Undo").click()
    assert p.locator('[data-kind="hosts"] .c-grid-row:not(.head):not(.new)').count() == rows

    # The logo and name always lead home, where the next step waits.
    p.locator('[data-k="home-link"]').click()
    p.wait_for_selector(".c-hero")
    assert p.locator('[data-k="next-step"]').inner_text().startswith("Next: check who sits where")

    # Starting over asks first, and can be undone.
    p.get_by_role("button", name="Event menu").click()
    button(p, "Start another dinner").click()
    assert "Replace " in words(p)
    button(p, "Cancel").click()
    assert p.locator("h1").inner_text() != "Let's set up your dinner"
    p.get_by_role("button", name="Event menu").click()
    button(p, "Start another dinner").click()
    p.locator('[data-k="replace-dinner"]').click()
    p.locator(".c-toast").get_by_role("button", name="Undo").click()
    p.locator('[data-k="home-link"]').click() if p.locator('[data-k="home-link"]').count() else None
    p.wait_for_selector(".c-hero")


def test_the_dinner_travels_to_a_phone_in_a_link(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context()
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        p = ctx.new_page()
        p.goto(url)
        p.wait_for_selector("text=Plan your rotation dinner")
        p.get_by_text("Start a dinner").click()
        name_dinner(p, "Phone Dinner")
        add_people(p, "hosts", ALUMNI)
        add_people(p, "fams", FAMS)
        p.wait_for_selector(".c-room")
        p.get_by_role("button", name="Event menu").click()
        button(p, "Send to your phone").click()
        button(p, "Copy the link").click()
        link = p.evaluate("navigator.clipboard.readText()")
        assert "#take=" in link
        phone = browser.new_context().new_page()
        phone.goto(link)
        phone.wait_for_selector(".c-hero")
        assert phone.locator("h1").inner_text() == "Phone Dinner"
        assert "#take=" not in phone.url
        browser.close()


def test_each_printout_opens_on_its_own_as_a_pdf(page):
    p = page
    p.get_by_text("See the STEW 2026 dinner").click()
    p.wait_for_selector(".c-room")
    button(p, "Looks good: print").click()
    labels = ["Room chart", "Alumni cards", "Table numbers", "Run sheet"]
    for i, label in enumerate(labels):
        with p.expect_popup() as pop:
            p.locator(f'[data-k="doc-{label}"]').click()
        doc = pop.value
        doc.wait_for_load_state()
        assert doc.title() == f"STEW 2026 Family Dinner: {label}"
        assert "Save as PDF" in doc.inner_text(".bar")
        assert doc.locator(".part").count() == 1
        doc.close()
        if i < len(labels) - 1:
            assert "You are ready for the event." not in words(p)
    # Once every printout has been opened, the app counts the event as printed.
    assert "You are ready for the event." in words(p)
    assert p.locator(".c-opened-tag").count() == 0 or p.locator(".c-docs li.opened").count() == 4


def test_a_first_dinner_explains_itself(page):
    # Nothing is assumed about what a first-time coordinator has, close words count, every table says why,
    # the schedule is done only once they say it looks good, and the night has one timeline.
    p = page
    p.get_by_text("Start a dinner").click()
    assert p.locator(".c-have").count() == 0, "no question before the paste: the box reads whatever they have"
    type_people(p, "hosts", "Ann Lee, medicine\nBo Kim, engineering\nCy Park, law")
    assert "Close interests count too, so medicine also matches biology and pre-med." in words(p)
    type_people(p, "fams", "Fam 1, biology\nFam 2, math\nFam 3, political science")
    p.wait_for_selector(".c-room")
    # Three rounds of three tables: each alum meets every fam once, and one round in three is their match.
    assert "The best match for these lists: 3 conversations share an interest." in words(p)
    assert p.locator(".c-tile-why.good").count() >= 1 and "No shared interest" not in words(p)
    schedule = p.locator(".c-tab", has_text="Your dinner")
    assert "ready" in schedule.get_attribute("aria-label"), "made is not the same as checked"
    button(p, "Looks good: print").click()
    assert "done" in schedule.get_attribute("aria-label")
    assert p.locator('[data-k="no-doors"]').count() == 1, "the run sheet's blank times are pointed out"

    p.locator(".c-tab", has_text="Your dinner").click()
    p.locator('[data-k="change-times"]').click()
    p.get_by_label("Doors open").fill("6:30 PM")
    p.get_by_label("Doors open").press("Tab")
    # Minutes are typed, not picked from a list.
    p.get_by_label("Each round").fill("12")
    p.get_by_label("Each round").press("Tab")
    p.get_by_label("Open floor at the end").fill("30")
    p.get_by_label("Open floor at the end").press("Tab")
    line = p.inner_text(".c-timing")
    assert "12 min" in line and "30 min open floor" in line and "6:30 PM to 8:01 PM" in line
    p.locator(".c-tab", has_text="Print").click()
    assert p.locator('[data-k="no-doors"]').count() == 0


def test_the_night_shows_itself_before_any_names(page):
    # Before a single name, two numbers show the rotation working, and Watch the night plays it.
    p = page
    p.get_by_text("Start a dinner").click()
    assert p.locator(".c-sample-night").count() == 1
    assert p.locator(".c-sample-table").count() == 10 and p.locator(".c-sample-alum").count() == 10
    p.locator('[data-k="more-tables"]').click()
    p.locator('[data-k="more-alumni"]').click()
    assert p.inner_text('[data-k="n-tables"]') == "11" and p.locator(".c-sample-alum").count() == 11
    p.locator('[data-k="watch-sample"]').click()
    p.wait_for_function("() => document.querySelector('.c-sample-round').textContent.startsWith('Round 2')", timeout=4000)
    assert "nobody visits a table twice" in words(p)
    # Once the lists are in, the room is real and the sample goes.
    type_people(p, "hosts", "Ann Lee, medicine\nBo Kim, law")
    # One list already previews the real night: the sample now uses their alumni.
    assert p.inner_text('[data-k="n-alumni"]') == "2" and "from your list" in p.inner_text(".c-sample-night")
    type_people(p, "fams", "Fam 1, biology\nFam 2, political science")
    p.wait_for_selector(".c-room")
    assert p.locator(".c-sample-night").count() == 0
    p.locator('[data-k="watch"]').click()
    p.wait_for_function("() => document.querySelector('[data-k=\"show-2\"]')?.getAttribute('aria-pressed') === 'true'", timeout=4000)
