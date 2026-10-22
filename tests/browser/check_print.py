"""Print the host cards to PDF in Chromium and check that no card is clipped.

Run by tests/browser/test_print_pdf.py. Each card must show its name, every
round, and its footer on one page.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path


def pdf_pages(html_text: str, browser=None) -> list[str]:
    """Print the page to US Letter PDF and return the text of each page.

    Pass an open Playwright browser to reuse it; otherwise one is started.
    """
    from playwright.sync_api import sync_playwright

    def render(b, page_file, pdf_file):
        page = b.new_page()
        page.goto(page_file.as_uri())
        page.pdf(path=str(pdf_file), format="Letter", print_background=True)
        page.close()

    with tempfile.TemporaryDirectory() as tmp:
        page_file = Path(tmp) / "page.html"
        pdf_file = Path(tmp) / "page.pdf"
        page_file.write_text(html_text, encoding="utf-8")
        if browser is not None:
            render(browser, page_file, pdf_file)
        else:
            with sync_playwright() as pw:
                b = pw.chromium.launch()
                render(b, page_file, pdf_file)
                b.close()
        text = subprocess.run(["pdftotext", "-layout", str(pdf_file), "-"], capture_output=True, text=True, check=True).stdout
    return text.split("\f")


def clipped_cards(html_text: str, host_names: list[str], rounds: int, browser=None) -> list[str]:
    """Host names whose card is not whole on a single page."""
    pages = pdf_pages(html_text, browser)
    bad = []
    for name in host_names:
        homes = [p for p in pages if name in p]
        if len(homes) != 1:
            bad.append(name)
            continue
        page = homes[0]
        block = page[page.index(name):]
        if any(f"Round {r}" not in block for r in range(1, rounds + 1)) or "Move when the MC calls the round" not in block:
            bad.append(name)
    return bad
