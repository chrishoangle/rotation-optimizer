"""Smoke test for the Streamlit app. Skipped when streamlit is not installed, as in CI."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest  # noqa: E402

APP = Path(__file__).resolve().parents[1] / "app" / "streamlit_app.py"


def test_app_solves_the_template():
    at = AppTest.from_file(str(APP), default_timeout=60).run()
    assert not at.exception
    at.button[0].click().run()
    assert not at.exception
    assert at.metric[0].value == "341"
    assert at.metric[1].value == "Yes"
