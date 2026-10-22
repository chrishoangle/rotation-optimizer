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
        assert [tuple(r) for r in got[: len(rows)]] == rows
        assert got[len(rows)] == [""] * len(rows[0])  # one empty row is left for the next entry
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
    before = button(p, "Cancel fam").bounding_box()["y"]
    button(p, "Cancel host").click()
    p.wait_for_selector("text=Yes, cancel Pharmacy")
    assert abs(button(p, "Cancel fam").bounding_box()["y"] - before) < 2  # the question appears below both rows
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
    page_html = Path(downloaded(p, "Download", 4).path()).read_text()
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
