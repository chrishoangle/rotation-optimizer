"""Streamlit app: plan a rotation schedule in the browser, no Python needed.

Run locally:
    pip install -e ".[app]"
    streamlit run app/streamlit_app.py

Coordinators edit the two tables on the page (or upload CSVs exported from
a spreadsheet), choose the number of rounds, and download a schedule CSV
and a printable seating chart.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pandas as pd
import streamlit as st

ROOT = Path(__file__).resolve().parents[1]
try:
    import rotation_optimizer  # noqa: F401
except ImportError:  # running from a clone without pip install, e.g. Streamlit Community Cloud
    sys.path.insert(0, str(ROOT / "src"))

from rotation_optimizer import (  # noqa: E402
    InfeasibleProblemError,
    SheetError,
    load_fams,
    load_hosts,
    plan_event,
    schedule_csv,
    schedule_rows,
    seating_chart_html,
)

TEMPLATES = ROOT / "templates"

st.set_page_config(page_title="Rotation Optimizer", layout="wide")
st.title("Rotation Optimizer")
st.write(
    "Plan which host table visits which fam in each round. Hosts rotate, fams stay seated, "
    "and no fam meets the same host twice. The solver picks the schedule with the highest total "
    "match score, where each pairing scores round(100 x shared tags / all tags)."
)


def _read_csv(uploaded, fallback: Path) -> pd.DataFrame:
    source = uploaded if uploaded is not None else fallback
    return pd.read_csv(source, dtype=str, keep_default_na=False)


with st.sidebar:
    st.header("Event")
    title = st.text_input("Event name", "Alumni dinner")
    rounds = st.number_input("Rounds", min_value=1, max_value=20, value=2, step=1)
    st.header("Start from")
    up_hosts = st.file_uploader("Hosts CSV (optional)", type="csv")
    up_fams = st.file_uploader("Fams CSV (optional)", type="csv")
    st.caption("Without uploads, the tables start from the example dinner. Templates are in the repo's templates/ folder.")

st.subheader("1. Host tables")
st.caption("One row per host table. Tags are keywords separated by semicolons. A tag only counts when a fam lists the same word.")
hosts_df = st.data_editor(_read_csv(up_hosts, TEMPLATES / "hosts.csv"), num_rows="dynamic", width="stretch", key="hosts")

st.subheader("2. Fams")
st.caption("One row per stationary table of guests. Interests use the same keyword style as host tags.")
fams_df = st.data_editor(_read_csv(up_fams, TEMPLATES / "fams.csv"), num_rows="dynamic", width="stretch", key="fams")

st.subheader("3. Solve")
if st.button("Find the best schedule", type="primary"):
    try:
        hosts = load_hosts(io.StringIO(hosts_df.to_csv(index=False)))
        fams = load_fams(io.StringIO(fams_df.to_csv(index=False)))
        with st.spinner("Solving"):
            plan = plan_event(hosts, fams, int(rounds))
    except SheetError as err:
        st.error("Please fix these rows:\n\n" + "\n".join(f"- {p}" for p in err.problems))
        st.stop()
    except InfeasibleProblemError as err:
        st.error(f"Cannot plan this event: {err}")
        st.stop()

    c1, c2, c3 = st.columns(3)
    c1.metric("Total match score", plan.total_score)
    c2.metric("Proven best possible", "Yes" if plan.proven_optimal else "Not proven")
    c3.metric("Zero-score pairings", len(plan.zero_slots()))

    for w in plan.warnings:
        st.warning(w)

    rows = pd.DataFrame(schedule_rows(plan))
    tabs = st.tabs([f"Round {r}" for r in range(1, plan.rounds + 1)])
    for r, tab in enumerate(tabs, start=1):
        with tab:
            tab.dataframe(rows[rows["round"] == r].drop(columns="round"), hide_index=True, width="stretch")

    d1, d2 = st.columns(2)
    d1.download_button("Download schedule CSV", schedule_csv(plan), file_name="schedule.csv", mime="text/csv")
    d2.download_button(
        "Download printable seating chart",
        seating_chart_html(plan, title=title),
        file_name="seating_chart.html",
        mime="text/html",
    )
