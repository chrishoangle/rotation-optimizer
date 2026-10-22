"""Checks that need a real browser: printing to PDF and typing into the tables.

Skipped unless Playwright with Chromium is installed (pip install playwright,
then playwright install chromium). The PDF check also needs pdftotext.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

pytest.importorskip("playwright.sync_api")
sys.path.insert(0, str(Path(__file__).parent))

from check_print import clipped_cards  # noqa: E402

from rotation_optimizer import host_cards_html, load_fams, load_hosts, plan_event  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="needs pdftotext")
@pytest.mark.parametrize("rounds", [2, 3, 6])
def test_no_host_card_is_clipped_when_printed(rounds):
    hosts = load_hosts(ROOT / "templates" / "practice_hosts.csv")
    plan = plan_event(hosts, load_fams(ROOT / "templates" / "practice_fams.csv"), rounds)
    assert clipped_cards(host_cards_html(plan, title="Example dinner"), [h.name for h in hosts], rounds) == []


@pytest.fixture(scope="module")
def app_url():
    pytest.importorskip("streamlit")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
    proc = subprocess.Popen(
        [sys.executable, "-m", "streamlit", "run", str(ROOT / "app" / "streamlit_app.py"), "--server.headless", "true",
         "--server.port", str(port), "--browser.gatherUsageStats", "false"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            urllib.request.urlopen(url + "/_stcore/health", timeout=1)
            break
        except OSError:
            time.sleep(0.5)
    yield url
    proc.terminate()
    proc.wait(timeout=10)


def _cell(page, grid, col, row):
    return page.evaluate(
        f'()=>document.querySelectorAll("[data-testid=stDataFrame]")[{grid}]'
        f'.querySelector("[data-testid=glide-cell-{col}-{row}]")?.innerText'
    )


def test_typing_six_hosts_with_tab_keeps_every_value_in_its_cell(app_url):
    from playwright.sync_api import sync_playwright

    rows = [("Medicine", "Alum A", "medicine; biology"), ("Law", "Alum B", "law; policy"), ("Tech", "Alum C", "software"),
            ("Art", "Alum D", "art; design"), ("Finance", "Alum E", "finance"), ("Teaching", "Alum F", "education")]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(app_url)
        page.wait_for_selector("text=1. Host tables", timeout=60000)
        page.wait_for_timeout(2500)
        page.get_by_role("button", name="Start a blank event").click()
        page.wait_for_timeout(3000)
        grid = page.locator('[data-testid="stDataFrame"]').nth(0)
        grid.scroll_into_view_if_needed()
        page.wait_for_timeout(500)
        box = grid.bounding_box()
        for i, row in enumerate(rows):
            x, y = box["x"] + 120, box["y"] + 35 + 35 * i + 17
            page.mouse.move(x, y, steps=6)
            page.mouse.click(x, y)
            page.wait_for_timeout(250)
            for j, value in enumerate(row):
                page.keyboard.type(value, delay=40)  # about 150 words a minute
                page.keyboard.press("Tab" if j < 2 else "Enter", delay=40)
            page.wait_for_timeout(250)
        page.wait_for_timeout(1000)
        got = [tuple(_cell(page, 0, c, r) for c in (1, 2, 3)) for r in range(len(rows))]
        browser.close()
    assert got == rows
