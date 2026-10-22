"""Streamlit app: plan a rotation, handle cancellations, and print, with no Python needed.

Run locally:
    pip install -e ".[app]"
    streamlit run app/streamlit_app.py

Coordinators edit the host and fam tables (or upload CSVs exported from a
spreadsheet), add pairing rules, and solve. On the night, they mark rounds
as finished, cancel hosts or fams, and re-plan. The re-plan keeps the
printed schedule wherever it can and lists exactly which host cards to
reprint.
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
    host_cards_html,
    load_fams,
    load_hosts,
    parse_rule_rows,
    plan_changes,
    plan_event,
    removed_after_lock,
    replan,
    reprint_list,
    schedule_csv,
    schedule_rows,
    seating_chart_html,
    table_tents_html,
)
from rotation_optimizer.sheets import RULE_KINDS  # noqa: E402

TEMPLATES = ROOT / "templates"
EDITOR_HEIGHT = 300  # fixed height so the page, not the table, scrolls

st.set_page_config(page_title="Rotation Optimizer", layout="wide")
state = st.session_state
for key, default in [("plan", None), ("previous", None), ("cancel_hosts", {}), ("cancel_fams", {}), ("message", None)]:
    state.setdefault(key, default)

st.title("Rotation Optimizer")
st.write(
    "Plan which host table visits which fam in each round. Hosts rotate, fams stay seated, "
    "and no fam meets the same host twice. Add your own pairing rules, re-plan when someone "
    "cancels, and print host cards, table tents, and a seating chart."
)


def _read_csv(uploaded, fallback: Path) -> pd.DataFrame:
    source = uploaded if uploaded is not None else fallback
    return pd.read_csv(source, dtype=str, keep_default_na=False)


def _records(df: pd.DataFrame) -> list[dict[str, str]]:
    return df.fillna("").astype(str).to_dict("records")


with st.sidebar:
    st.header("Event")
    title = st.text_input("Event name", "Alumni dinner")
    rounds = int(st.number_input("Rounds", min_value=1, max_value=20, value=2, step=1))
    st.header("Start from")
    up_hosts = st.file_uploader("Hosts CSV (optional)", type="csv")
    up_fams = st.file_uploader("Fams CSV (optional)", type="csv")
    st.caption("Without uploads, the tables start from the example dinner. Templates are in the repo's templates/ folder.")

st.subheader("1. Host tables")
st.caption("One row per host table. Tags are keywords separated by semicolons. A tag only counts when a fam lists the same word.")
hosts_df = st.data_editor(
    _read_csv(up_hosts, TEMPLATES / "hosts.csv"), num_rows="dynamic", width="stretch", height=EDITOR_HEIGHT, key="hosts"
)

st.subheader("2. Fams")
st.caption("One row per seated table of guests. table_number is the number on the table in the room; blank rows get the next free number.")
fams_df = st.data_editor(
    _read_csv(up_fams, TEMPLATES / "fams.csv"), num_rows="dynamic", width="stretch", height=EDITOR_HEIGHT, key="fams"
)

host_labels = [s for s in hosts_df.get("table_label", pd.Series(dtype=str)).astype(str) if s.strip()]
fam_labels = [s for s in fams_df.get("fam_label", pd.Series(dtype=str)).astype(str) if s.strip()]

st.subheader("3. Pairing rules (optional)")
st.caption(
    "must meet: the pair meets once, in one of the listed rounds (blank means any round). "
    "never meet: the pair never meets in the listed rounds (blank means never). "
    "only in rounds: the host is there only in the listed rounds; leave fam blank."
)
rules_df = st.data_editor(
    pd.DataFrame({"rule": pd.Series(dtype=str), "host_table": pd.Series(dtype=str), "fam": pd.Series(dtype=str), "rounds": pd.Series(dtype=str)}),
    num_rows="dynamic",
    width="stretch",
    key="rules",
    column_config={
        "rule": st.column_config.SelectboxColumn("rule", options=list(RULE_KINDS)),
        "host_table": st.column_config.SelectboxColumn("host_table", options=host_labels),
        "fam": st.column_config.SelectboxColumn("fam", options=fam_labels),
        "rounds": st.column_config.TextColumn("rounds", help="Round numbers separated by commas, for example 1, 2"),
    },
)

st.subheader("4. Plan")
if st.button("Find the best schedule", type="primary"):
    try:
        hosts = load_hosts(io.StringIO(hosts_df.to_csv(index=False)))
        fams = load_fams(io.StringIO(fams_df.to_csv(index=False)))
        rules, host_away = parse_rule_rows(_records(rules_df), hosts, fams, rounds)
        with st.spinner("Solving"):
            state.plan = plan_event(hosts, fams, rounds, rules=rules, host_away=host_away)
        state.previous = None
        state.cancel_hosts, state.cancel_fams = {}, {}
        state.message = None
    except SheetError as err:
        st.error("Please fix these first:\n\n" + "\n".join(f"- {p}" for p in err.problems))
    except InfeasibleProblemError as err:
        st.error(str(err))

plan = state.plan
if plan is None:
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
    tab.dataframe(rows[rows["round"] == r].drop(columns="round"), hide_index=True, width="stretch")

d1, d2, d3, d4 = st.columns(4)
d1.download_button("Schedule CSV", schedule_csv(plan), file_name="schedule.csv", mime="text/csv")
d2.download_button("Seating chart", seating_chart_html(plan, title=title), file_name="seating_chart.html", mime="text/html")
d3.download_button("Host cards", host_cards_html(plan, title=title), file_name="host_cards.html", mime="text/html")
d4.download_button("Table tents", table_tents_html(plan), file_name="table_tents.html", mime="text/html")
st.caption("Open a downloaded page in your browser and print it on US Letter.")

st.subheader("5. Changes on the night")
st.caption(
    "Mark the rounds that already happened, cancel anyone who cannot come, then re-plan. "
    "Finished rounds never change."
)
finished = int(st.number_input("Rounds already finished", min_value=0, max_value=plan.rounds - 1, value=0, step=1, key="finished"))
gone = removed_after_lock(plan, host_labels, fam_labels) if (finished or plan.locked_rounds) else []
if gone:
    st.error(
        f"You removed {', '.join(gone)} from the tables above. Rounds have already happened, so removing a row "
        "would rewrite them. Undo the removal, then use Cancel a host or Cancel a fam below."
    )

hosts_by_name = {h.name: h.host_id for h in plan.hosts}
fams_by_name = {f.name: f.group_id for f in plan.fams}
first_open = finished + 1

hc1, hc2, hc3 = st.columns([3, 1, 1])
cancel_host = hc1.selectbox("Cancel a host", list(hosts_by_name), key="cancel_host_name")
# Only rounds that have not happened yet can be chosen.
open_rounds = list(range(first_open, plan.rounds + 1))
cancel_host_round = hc2.selectbox("from round", open_rounds, key=f"cancel_host_round_{finished}")
if hc3.button("Cancel host", key="cancel_host_btn"):
    state.cancel_hosts[hosts_by_name[cancel_host]] = int(cancel_host_round)

fc1, fc2, fc3 = st.columns([3, 1, 1])
cancel_fam = fc1.selectbox("Cancel a fam", list(fams_by_name), key="cancel_fam_name")
cancel_fam_round = fc2.selectbox("from round", open_rounds, key=f"cancel_fam_round_{finished}")
if fc3.button("Cancel fam", key="cancel_fam_btn"):
    state.cancel_fams[fams_by_name[cancel_fam]] = int(cancel_fam_round)

pending = [(plan.host_name(h), r, "host", h) for h, r in state.cancel_hosts.items()]
pending += [(plan.fam_name(f), r, "fam", f) for f, r in state.cancel_fams.items()]
for name, r, kind, ident in pending:
    pc1, pc2 = st.columns([5, 1])
    pc1.write(f"Cancelled from round {r}: {name}")
    if pc2.button("Undo", key=f"undo_{kind}_{ident}"):
        (state.cancel_hosts if kind == "host" else state.cancel_fams).pop(ident, None)
        st.rerun()

mode = st.radio(
    "How to re-plan",
    ["Keep the printed schedule where possible", "Re-plan from scratch (nothing printed yet)"],
    key="mode",
)
if st.button("Re-plan", type="primary", disabled=bool(gone), key="replan_btn"):
    try:
        new = replan(
            plan,
            finished,
            cancel_hosts=state.cancel_hosts,
            cancel_fams=state.cancel_fams,
            from_scratch=mode.startswith("Re-plan from scratch"),
        )
        state.previous, state.plan = plan, new
        state.cancel_hosts, state.cancel_fams = {}, {}
        st.rerun()
    except InfeasibleProblemError as err:
        st.error(str(err))

if state.previous is not None:
    old, new = state.previous, state.plan
    tables = {f.group_id: (f.table_number or i) for i, f in enumerate(new.fams, start=1)}
    changes = plan_changes(old, new)
    st.markdown("**What changed in the last re-plan**")
    if changes:
        st.dataframe(
            pd.DataFrame(
                [
                    {
                        "round": c.round_number,
                        "table": tables[c.fam_id],
                        "fam": new.fam_name(c.fam_id),
                        "before": old.host_name(c.before) if c.before else "No host",
                        "after": new.host_name(c.after) if c.after else "No host",
                    }
                    for c in changes
                ]
            ),
            hide_index=True,
            width="stretch",
        )
    else:
        st.write("Nothing changed.")
    reprint_hosts, reprint_tents = reprint_list(old, new)
    names = ", ".join(new.host_name(h) for h in reprint_hosts) or "none"
    st.markdown(f"**Reprint these host cards:** {names}")
    st.markdown(
        "**Reprint these table tents:** "
        + (", ".join(new.fam_name(f) for f in reprint_tents) if reprint_tents else "none. Tents show only the table number and fam name, which did not change.")
    )
    if reprint_hosts:
        st.download_button(
            "Download only the host cards to reprint",
            host_cards_html(new, host_ids=reprint_hosts, title=title),
            file_name="host_cards_reprint.html",
            mime="text/html",
            key="reprint_download",
        )
