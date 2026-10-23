"""The web app in docs/app, driven in a real browser at 1280 px.

The same coordinator steps the Streamlit app was checked with: the example,
the four printouts, saving and reopening, typing new tables, a Google Forms
upload, rules and a deliberate conflict, a cancellation on the night of a
3 round dinner, and the hand-off. Skipped unless Playwright with Chromium is
installed and docs/app has been built (cd web && npm ci && npm run build).
"""

from __future__ import annotations

import functools
import http.server
import io
import json
import re
import shutil
import sys
import threading
import zipfile
from pathlib import Path

import pytest

pytest.importorskip("playwright.sync_api")
sys.path.insert(0, str(Path(__file__).parent))

from check_print import clipped_cards  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "docs" / "app"
pytestmark = pytest.mark.skipif(not (APP / "app.js").exists(), reason="build the web app first: cd web && npm run build")


@pytest.fixture(scope="module")
def url():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs"))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/app/"
    server.shutdown()


@pytest.fixture()
def page(url):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        p = ctx.new_page()
        errors: list[str] = []
        p.on("pageerror", lambda e: errors.append(str(e)))
        p.goto(url)
        p.wait_for_selector("text=1. Host tables")
        p.errors = errors
        yield p
        assert errors == []
        browser.close()


def text(p) -> str:
    return p.inner_text("body")


def button(p, name: str):
    return p.get_by_role("button", name=name, exact=True)


def downloaded(p, name: str, nth: int = 0):
    with p.expect_download() as d:
        button(p, name).nth(nth).click()
    return d.value


def page_y(p, name: str) -> float:
    """A button's position on the page, not the screen, so a scroll still in progress does not count."""
    return button(p, name).evaluate("b => b.getBoundingClientRect().top + window.scrollY")


def start_round_1(p) -> None:
    """Start the event in night mode, past the room setup warning."""
    if button(p, "Start anyway").count():
        button(p, "Start anyway").click()
    button(p, "Start round 1").click()
    p.wait_for_selector("text=minutes left")


def set_number(p, label: str, value: int) -> None:
    box = p.get_by_label(label, exact=True)
    box.fill(str(value))
    box.press("Tab")
    p.wait_for_timeout(200)


def find(p) -> None:
    p.locator("#find").click()
    p.wait_for_function("() => !document.querySelector('#find-status .spinner')")
    p.wait_for_timeout(300)


def test_example_prints_four_pages_without_clipping(page):
    p = page
    cards = {}
    for rounds in (2, 3, 6):
        set_number(p, "Rounds", rounds)
        find(p)
        assert f"Planned for {rounds} rounds" in text(p)
        names = [downloaded(p, "Download", i).suggested_filename for i in range(4)]
        assert [n.split(" ")[2] for n in names] == ["seating", "host", "table", "run"]
        cards[rounds] = Path(downloaded(p, "Download", 1).path()).read_text()
    hosts = re.findall(r"<h2>(.*?)</h2>", cards[2])
    for rounds, html in cards.items():
        assert clipped_cards(html, [h.replace("&amp;", "&") for h in hosts], rounds, p.context.browser) == []


def test_save_reload_and_reopen_keep_the_printed_version(page, tmp_path):
    p = page
    find(p)
    button(p, "Mark as printed").click()
    saved = tmp_path / "event.rotation.json"
    downloaded(p, "Save event file (keep this to continue later)").save_as(saved)
    p.reload()
    p.wait_for_selector("text=1. Host tables")
    assert "was restored from this browser" in text(p)
    p.get_by_text("Before the night:").click()
    assert "Done The printed version is marked." in text(p).replace("\n", " ")
    button(p, "Start a blank event").click()
    p.locator("#open-event").set_input_files(saved)
    p.wait_for_selector("text=Opened event.rotation.json.")
    assert "Printed at" in text(p)


def test_typing_six_hosts_and_eight_fams_with_tab(page):
    p = page
    button(p, "Start a blank event").click()
    hosts = [("Medicine", "Alum A", "medicine; biology"), ("Law", "Alum B", "law; policy"), ("Tech", "Alum C", "software; data"),
             ("Art", "Alum D", "art; design"), ("Finance", "Alum E", "finance; economics"), ("Teaching", "Alum F", "education; history")]
    fams = [(str(i), f"Fam {n}", "6", t, f"Student {i}A; Student {i}B") for i, (n, t) in enumerate(
        [("Red", "biology"), ("Blue", "law"), ("Gold", "data"), ("Teal", "design"), ("Pink", "economics"),
         ("Gray", "history"), ("Lime", "medicine; data"), ("Navy", "art; policy")], start=1)]
    for table, rows in (("hosts", hosts), ("fams", fams)):
        for i, row in enumerate(rows):
            p.locator(f'table[data-table="{table}"] tbody tr').nth(i).locator("input").first.click()
            for j, value in enumerate(row):
                p.keyboard.type(value, delay=40)
                if j < len(row) - 1:
                    p.keyboard.press("Tab")
    for table, rows in (("hosts", hosts), ("fams", fams)):
        got = p.eval_on_selector_all(f'table[data-table="{table}"] tbody tr',
                                     "trs => trs.map(tr => [...tr.querySelectorAll('input')].map(i => i.value))")
        assert [tuple(r[: len(rows[0])]) for r in got[: len(rows)]] == rows
        assert set(got[len(rows)]) == {""}  # one empty row is left for the next entry
    find(p)
    assert "Planned for 2 rounds, 8 fams and 6 host tables." in text(p)


def test_google_form_upload_drops_email_and_groups_students(page, tmp_path):
    p = page
    form = tmp_path / "form.csv"
    form.write_text("Timestamp,Email Address,Your name,Which fam are you in?,Intended major(s)\n"
                    "10/1/2026 9:00,a@example.com,Student 01,Fam Red,Biology\n"
                    "10/1/2026 9:01,b@example.com,Student 02,Fam Red,\"Chemistry, Pre-med\"\n"
                    "10/1/2026 9:02,c@example.com,Student 03,Fam Blue,Law\n")
    p.locator("#up-fams").set_input_files(form)
    p.wait_for_selector("text=grouped into 2 fams")
    assert "Waiting for you to confirm on the page." in text(p)
    button(p, "Replace 10 fams with these 2").click()
    saved = Path(downloaded(p, "Save event file (keep this to continue later)").path()).read_text()
    assert "example.com" not in saved and "Student 01; Student 02" in saved
    button(p, "Undo upload").click()
    assert len(json.loads(Path(downloaded(p, "Save event file (keep this to continue later)").path()).read_text())["fams"]) == 10


def test_rules_plan_and_a_conflict_is_named(page):
    p = page
    rows = p.locator('table[data-table="rules"] tbody tr')

    def rule(i, kind, host, fam, rounds):
        r = rows.nth(i)
        r.locator('select[data-col="rule"]').select_option(kind)
        r.locator('select[data-col="host_table"]').select_option(host)
        if fam:
            r.locator('select[data-col="fam"]').select_option(fam)
        if rounds:
            r.locator('input[data-col="rounds"]').fill(rounds)

    rule(0, "must meet", "Pharmacy", "Bio & Chem", "2")
    rule(1, "never meet", "Physician (MD)", "Cog Sci & Pre-Health", "")
    rule(2, "only in rounds", "Academic Mentorship", "", "1")
    find(p)
    assert "Proven best possible" in text(p) and "Please fix" not in text(p)
    rule(3, "only in rounds", "Pharmacy", "", "1")
    find(p)
    assert "Pharmacy must meet Bio & Chem in round 2 cannot hold because Pharmacy only comes for round 1" in text(p)


def test_night_of_a_three_round_dinner(page):
    p = page
    set_number(p, "Rounds", 3)
    find(p)
    button(p, "Mark as printed").click()
    set_number(p, "Rounds already finished", 1)
    p.get_by_label("Cancel a host", exact=True).select_option(label="Pharmacy")
    before = page_y(p, "Cancel fam")
    button(p, "Cancel host").click()
    p.wait_for_selector("text=Yes, cancel Pharmacy")
    assert abs(page_y(p, "Cancel fam") - before) < 2  # the question appears below both rows
    button(p, "Yes, cancel Pharmacy").click()
    p.wait_for_selector("text=Pharmacy is cancelled from round 2.")
    p.get_by_label("Cancel a fam", exact=True).select_option(label="Bio & Chem")
    button(p, "Cancel fam").click()
    button(p, "Yes, cancel Bio & Chem").click()
    p.wait_for_selector("text=Bio & Chem is cancelled from round 2.")
    button(p, "Re-plan").click()
    p.wait_for_selector("text=Schedule updated.")
    p.wait_for_selector("text=Reprint:")
    body = text(p)
    assert "Pharmacy: cancelled from round 2" in body and "Bio & Chem: cancelled from round 2" in body
    assert re.search(r"Reprint: .*seating chart, round 2 page and round 3 page", body)
    with p.expect_download() as d:
        p.locator(".card", has_text="Reprint seating chart pages").get_by_role("button", name="Download").click()
    page_html = Path(d.value.path()).read_text()
    assert "Replaces the earlier copy" in page_html
    assert jargon(body) == []


JARGON = [r"\bNone\b", r"\bnan\b", r"\bNaN\b", r"\bnull\b", r"\bundefined\b", r"\bslots?\b", r"\blocked\b", r"\(s\)",
          r"\bJSON\b", r"\bCSV\b", r"\bh\d\d\b", r"\bfam_\d\d\b", r"padding", r"table_label", r"fam_label", r"host_id"]


def jargon(body: str) -> list[str]:
    body = body.replace("save it as CSV", "")
    return [pattern for pattern in JARGON if re.search(pattern, body)]


def test_hand_off_is_a_folder_with_a_readme(page):
    p = page
    z = zipfile.ZipFile(io.BytesIO(Path(downloaded(p, "Hand off to next year").path()).read_bytes()))
    names = z.namelist()
    readme = z.read(next(n for n in names if n.endswith("README.txt"))).decode()
    event = json.loads(z.read(next(n for n in names if n.endswith(".rotation.json"))))
    assert "How to open it" in readme
    assert all(not r["students"] for r in event["fams"]) and event["plan"] is None


def paste(p, table: str, text: str) -> None:
    p.context.grant_permissions(["clipboard-read", "clipboard-write"])
    p.evaluate("t => navigator.clipboard.writeText(t)", text)
    p.locator(f'table[data-table="{table}"] tbody tr').first.locator("input").first.click()
    p.keyboard.press("ControlOrMeta+V")
    p.wait_for_timeout(200)


def test_paste_from_a_spreadsheet_and_every_alum_gets_a_table(page):
    p = page
    button(p, "Start a blank event").click()
    # A sheet with its own column order and a header row, as copied from Google Sheets.
    hosts = ["Tags\tHost table name\tAlum's name"] + [
        f"{t}\t{n}\tAlum {i}" for i, (n, t) in enumerate([
            ("Medicine", "medicine; biology"), ("Law", "law; policy"), ("Tech", "software; data"),
            ("Art", "art; design"), ("Finance", "finance; economics"), ("Teaching", "education; history"),
            ("Film & TV", "film; writing"), ("Real Estate", "real estate")], start=1)]
    paste(p, "hosts", "\r\n".join(hosts) + "\r\n")
    assert "Pasted 8 host tables, matching columns by the header row." in text(p)
    fams = [f"Fam {n}\t6\t{t}" for n, t in [("Red", "biology"), ("Blue", "law"), ("Gold", "data"), ("Teal", "design"),
                                           ("Pink", "economics"), ("Gray", "history")]]
    p.locator('table[data-table="fams"] tbody tr').first.locator("input").nth(1).click()
    p.context.grant_permissions(["clipboard-read", "clipboard-write"])
    p.evaluate("t => navigator.clipboard.writeText(t)", "\n".join(fams))
    p.keyboard.press("ControlOrMeta+V")
    p.wait_for_timeout(200)
    assert "Pasted 6 fams." in text(p)
    got = p.eval_on_selector_all('table[data-table="hosts"] tbody tr',
                                 "trs => trs.map(tr => [...tr.querySelectorAll('input')].map(i => i.value))")
    assert got[0] == ["Medicine", "Alum 1", "medicine; biology"] and len(got) == 9
    got = p.eval_on_selector_all('table[data-table="fams"] tbody tr',
                                 "trs => trs.map(tr => [...tr.querySelectorAll('input')].map(i => i.value))")
    assert got[5][1:4] == ["Fam Gray", "6", "history"]
    find(p)
    assert "Planned for 2 rounds, 6 fams and 8 host tables." in text(p)
    p.get_by_role("tab", name="Host view").click()
    rows = p.eval_on_selector_all("table.plain tbody tr", "trs => trs.map(tr => tr.innerText)")
    assert len(rows) == 8 and all("Table " in r for r in rows)  # 12 places, so all 8 host tables host
    assert "has no table in any round" not in text(p)


def test_night_mode_check_in_no_show_and_late_alum(page):
    p = page
    find(p)
    button(p, "Mark as printed").click()
    button(p, "Open night mode").click()
    p.wait_for_selector("text=Round 1 of 2")
    assert "Check-in: 0 of 10 alumni here" in text(p)
    button(p, "Not here yet").first.click()
    assert "Check-in: 1 of 10 alumni here" in text(p)
    button(p, "Didn't show").first.click()
    p.wait_for_selector("text=didn't show up. Cancel them from round 1?")
    button(p, "Yes, cancel").click()
    p.wait_for_selector("text=Changes are waiting")
    button(p, "An alum arrived late, or a new one came").click()
    p.get_by_label("Host table name").fill("Real Estate")
    p.get_by_label("Alum's name").fill("Alum K")
    p.get_by_label("Tags").fill("finance; economics")
    button(p, "Add").click()
    button(p, "Re-plan now").click()
    p.wait_for_selector("text=What to tell people")
    body = text(p)
    assert re.search(r"Alum K \(Real Estate\): new host\. In round 1, go to Table \d+", body)
    assert "Changes are waiting" not in body
    p.get_by_label("Where is").fill("alum k")
    assert "Round 2: Table" in p.inner_text("#where-results")
    start_round_1(p)
    button(p, "Round 1 is finished: hosts move now").click()
    assert "Moving to round 2 of 2" in text(p)
    p.get_by_text("Tonight's log").click()
    log = text(p)
    assert "did not show up, cancelled from round 1." in log and "Added Alum K (Real Estate) as a host from round 1." in log
    assert jargon(text(p)) == []
    # A reload during the event comes back to night mode.
    p.reload()
    p.wait_for_selector("text=Moving to round 2 of 2")
    p.set_viewport_size({"width": 390, "height": 844})
    assert p.evaluate("document.documentElement.scrollWidth") <= 390
    button(p, "Back to planning").click()
    p.wait_for_selector("text=1. Host tables")


def test_why_a_pairing_and_choosing_a_different_host(page):
    p = page
    find(p)
    assert re.search(r"Pairings that share an interest\s+18 of 20", text(p))
    row = p.locator("table.schedule tbody tr", has_text="Bio & Chem").first
    row.get_by_role("button", name="Why?").click()
    why = p.inner_text(".why")
    assert "Bio & Chem both list" in why or "shares none of Bio & Chem" in why
    pick = p.get_by_label("Host for Bio & Chem in round 1")
    current = pick.evaluate("s => s.value")
    other = pick.evaluate("(s, cur) => [...s.options].map(o => o.value).find(v => v !== cur)", current)
    pick.select_option(other)
    button(p, "Use this host").click()
    p.wait_for_selector("text=kept as a must meet rule")
    assert "Bio & Chem" in p.eval_on_selector_all('table[data-table="rules"] select[data-col="fam"]', "ss => ss.map(s => s.value).join()")
    button(p, "Undo").click()
    p.wait_for_selector("text=Undone: the rule is removed")
    assert "Bio & Chem" not in p.eval_on_selector_all('table[data-table="rules"] select[data-col="fam"]', "ss => ss.map(s => s.value).join()")


def test_works_with_no_internet_after_one_visit(page):
    p = page
    p.evaluate("() => navigator.serviceWorker.ready")
    p.reload()
    p.wait_for_selector("text=1. Host tables")
    p.wait_for_function("() => !!navigator.serviceWorker.controller")
    p.context.set_offline(True)
    try:
        p.reload()
        p.wait_for_selector("text=1. Host tables")
        find(p)
        assert "Proven best possible" in text(p)
        p.get_by_text("Working without internet").click()
        assert "saved on this device" in text(p)
    finally:
        p.context.set_offline(False)


def test_offline_copy_is_one_file_that_plans(page, tmp_path):
    p = page
    p.get_by_text("Working without internet").click()
    copy = tmp_path / "offline.html"
    downloaded(p, "Download an offline copy of this app").save_as(copy)
    assert copy.stat().st_size > 4_000_000
    q = p.context.new_page()
    errors: list[str] = []
    q.on("pageerror", lambda e: errors.append(str(e)))
    q.goto(copy.as_uri())
    q.wait_for_selector("text=1. Host tables")
    find(q)
    assert "Proven best possible" in text(q)
    assert errors == []


def test_mark_as_printed_downloads_a_backup_and_versions_can_be_restored(page):
    p = page
    find(p)
    with p.expect_download() as d:
        button(p, "Mark as printed").click()
    assert "printed backup" in d.value.suggested_filename
    set_number(p, "Rounds", 3)
    find(p)
    assert "Planned for 3 rounds" in text(p)
    p.get_by_text("Earlier versions in this browser").click()
    p.locator(".versions li", has_text="before re-planning").first.get_by_role("button", name="Restore").click()
    p.wait_for_selector("text=Restored the version from")
    assert "Planned for 2 rounds" in text(p)


def test_practice_the_night_changes_nothing(page):
    p = page
    find(p)
    assert "students in 10 fams" in p.inner_text("#fam-totals")
    before = Path(downloaded(p, "Save event file (keep this to continue later)").path()).read_text()
    button(p, "Practice the night").click()
    p.wait_for_selector("text=Practice:")
    button(p, "Didn't show").first.click()
    button(p, "Yes, cancel").click()
    button(p, "Re-plan now").click()
    p.wait_for_selector("text=What to tell people")
    button(p, "End practice").click()
    p.wait_for_selector("text=Practice ended. Your event is exactly as it was.")
    after = Path(downloaded(p, "Save event file (keep this to continue later)").path()).read_text()
    assert json.loads(after)["cancel_hosts"] == {} and json.loads(after)["night_log"] == []
    assert json.loads(after)["plan"] == json.loads(before)["plan"]


def test_remove_student_names_and_team_pages(page):
    p = page
    with p.expect_popup() as pop:
        button(p, "Coordinator guide (2 pages)").click()
    assert "if this happens, do this" in pop.value.inner_text("body")
    pop.value.close()
    button(p, "Remove student names").click()
    button(p, "Remove names").click()
    p.wait_for_selector("text=Student names removed.")
    saved = Path(downloaded(p, "Save event file (keep this to continue later)").path()).read_text()
    assert "Student 01" not in json.dumps(json.loads(saved)["fams"])


def test_room_setup_a_fam_at_the_wrong_table_and_a_late_alum(page):
    p = page
    find(p)
    button(p, "Mark as printed").click()
    button(p, "Open night mode").click()
    p.wait_for_selector("text=Room setup: 0 of 10 tables checked")
    p.locator(".setup li").first.get_by_role("button", name="Check").click()
    assert "Room setup: 1 of 10 tables checked" in text(p)
    # The original incident: a fam sat down at another table before the tents went out.
    p.locator(".setup li", has_text="Bio & Chem").get_by_role("button", name="Different table").click()
    p.get_by_label("Table the fam is at").fill("2")
    button(p, "They are at this table").click()
    p.wait_for_selector("text=Changes are waiting")
    button(p, "Re-plan now").click()
    p.wait_for_selector("text=What to tell people")
    tell = p.inner_text(".panel.tell")
    assert re.search(r"Bio & Chem is at Table 2, not Table 10 as your card says\.", tell)
    assert re.search(r"Cog Sci & Pre-Health is at Table 10, not Table 2 as your card says\.", tell)
    # An expected alum misses round 1, then turns up.
    button(p, "Didn't show").first.click()
    button(p, "Yes, cancel").click()
    button(p, "Re-plan now").click()
    p.wait_for_selector("text=What to tell people")
    start_round_1(p)
    button(p, "Round 1 is finished: hosts move now").click()
    if not p.eval_on_selector('[data-panel="checkin"]', "d => d.open"):
        p.locator('[data-panel="checkin"] > summary').click()
    p.locator(".checkin li.noshow").first.get_by_role("button", name="Arrived late").click()
    button(p, "Add them back").click()
    p.wait_for_selector("text=Changes are waiting")
    button(p, "Re-plan now").click()
    p.wait_for_selector("text=What to tell people")
    p.get_by_text("Tonight's log").click()
    assert "arrived late and hosts from round 2." in text(p)
    assert jargon(text(p)) == []


def test_rounds_on_a_clock_with_moves_ticked_and_changes_passed_on(page):
    p = page
    set_number(p, "Rounds", 3)
    find(p)
    button(p, "Mark as printed").click()
    button(p, "Open night mode").click()
    p.wait_for_selector("text=Room setup is not finished")
    assert "10 tables not checked in room setup" in p.inner_text(".now-board")
    start_round_1(p)
    assert "Round 1: 20 minutes left" in p.inner_text(".now-board")
    # Two alumni ended up at the wrong tables: keep it, and re-plan the rest around it.
    row = p.locator(".now-list li").first
    row.get_by_role("button", name="Not right?").click()
    pick = p.get_by_label("Who is actually at Table 1")
    other = pick.evaluate("s => [...s.options].find(o => !o.selected).value")
    pick.select_option(other)
    button(p, "Keep it this way").click()
    p.wait_for_selector("text=Changes are waiting")
    button(p, "Re-plan now").click()
    p.wait_for_selector("text=What to tell people")
    assert "not told yet" in p.inner_text(".panel.tell")
    first = p.locator(".panel.tell .told-list li").first
    first.get_by_role("button", name="Not told").click()
    assert p.locator(".panel.tell .told-list li").first.get_by_role("button", name="Told").count() == 1
    button(p, "Round 1 is finished: hosts move now").click()
    p.wait_for_selector("text=Moving to round 2 of 3")
    moving = p.locator(".moves li")
    n = moving.count()
    assert n >= 9 and f"0 of {n} alumni at their tables" in p.inner_text(".now-board")
    moving.first.get_by_role("button", name="Moving").click()
    assert f"1 of {n} alumni at their tables" in p.inner_text(".now-board")
    with p.expect_popup() as pop:
        button(p, "Print the MC cue card with updated times").click()
    assert "Round 2" in pop.value.inner_text("body") and "Round 3" in pop.value.inner_text("body")
    pop.value.close()
    button(p, "Start round 2").click()
    p.wait_for_selector("text=Round 2 of 3")
    assert "Round 1:" in text(p) and " to " in text(p)
    assert jargon(text(p)) == []


def test_volunteer_qr_view_students_runner_sheets_and_wrap_up(page):
    p = page
    find(p)
    with p.expect_popup() as pop:
        p.locator(".card", has_text="Runner sheets").get_by_role("button", name="Open to print").click()
    assert "runner 2 of 2" in pop.value.inner_text("body")
    pop.value.close()
    button(p, "Mark as printed").click()
    button(p, "Open night mode").click()
    p.locator('[data-panel="students"] > summary').click()
    for _ in range(2):
        p.get_by_label("One more at Bio & Chem").click()
    assert "2 of 6" in p.inner_text('[data-panel="students"]')
    assert "Few students yet at" in p.inner_text(".now-board")
    p.locator('[data-panel="share"] > summary').click()
    p.wait_for_selector(".qr svg")
    p.context.grant_permissions(["clipboard-read", "clipboard-write"])
    button(p, "Copy the link").click()
    link = p.evaluate("navigator.clipboard.readText()")
    assert "/app/view.html#" in link
    v = p.context.new_page()
    v.goto(link)
    v.wait_for_selector("text=Read only")
    assert "Table 10" in v.inner_text("body") and "Student" not in v.inner_text("body")
    v.get_by_label("Find an alum or a fam").fill("Pharmacy")
    assert "Round 2:" in v.inner_text("body")
    v.close()
    start_round_1(p)
    button(p, "Round 1 is finished: hosts move now").click()
    button(p, "Start round 2").click()
    button(p, "Round 2 is finished: the event is over").click()
    p.wait_for_selector("text=what would you change next year?")
    p.get_by_label("What would you change next year?").fill("Start check-in 15 minutes earlier.")
    button(p, "Save to notes for next year").click()
    button(p, "Back to planning").click()
    assert "Start check-in 15 minutes earlier." in p.get_by_label("Notes for next year").input_value()
