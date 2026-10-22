"""Streamlit app: plan a rotation, handle cancellations, and print, with no Python needed.

Run locally:
    pip install -e ".[app]"
    streamlit run app/streamlit_app.py

Everything about the event lives in one EventState under st.session_state
["event"], not in widget state, so a rerun or an error cannot drop tables,
rules, cancellations, or the schedule. Save event and Load event carry the
same state across a browser refresh, and the page warns before leaving with
unsaved changes. The logic lives in rotation_optimizer.event and is tested
without Streamlit. browser_fixes.js works around two table-editor quirks;
see that file.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import sys
from pathlib import Path

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

ROOT = Path(__file__).resolve().parents[1]
try:
    import rotation_optimizer  # noqa: F401
except ImportError:  # running from a clone without pip install, e.g. Streamlit Community Cloud
    sys.path.insert(0, str(ROOT / "src"))

from rotation_optimizer import (  # noqa: E402
    RELEASE_DATE,
    __version__,
    run_sheet_html,
    InfeasibleProblemError,
    SheetError,
    host_cards_html,
    host_view_rows,
    plan_changes,
    reprint_list,
    schedule_csv,
    schedule_rows,
    seating_chart_html,
    slot_text,
    table_tents_html,
)
from rotation_optimizer.event import (  # noqa: E402
    FAM_COLUMNS,
    HOST_COLUMNS,
    RULE_COLUMNS,
    EventState,
    apply_spelling,
    check_inputs,
    fingerprint,
    has_started,
    is_current,
    load_event,
    max_rounds,
    near_misses,
    normalize_state,
    normalize_table,
    removed_rows,
    restore_removed_rows,
    rounds_limit_text,
    before_the_night,
    handoff_event,
    save_event,
    solve_event,
)
from rotation_optimizer.sheets import (  # noqa: E402
    FILE_COLUMNS as FILE_COLUMNS_OF,
    FRIENDLY,
    RULE_KINDS,
    column_report,
    drop_example_rows,
    group_student_rows,
    match_columns,
    rename_columns,
    template_csv,
)

TEMPLATES = ROOT / "templates"
FIXES_JS = (Path(__file__).with_name("browser_fixes.js")).read_text()
EDITOR_HEIGHT = 300  # fixed height so the page, not the table, scrolls
COLUMN_NAMES = {"table": "Table", "fam": "Fam", "host_table": "Host table", "score": "Score", "host_name": "Alum"}
SCORE_LINE = (
    "How scores work: a pairing scores from 0 to 100, the share of all the tags the host and fam list that they "
    "have in common. Fam size does not count. The best schedule has the highest total."
)

st.set_page_config(page_title="Rotation Optimizer", layout="wide")
ss = st.session_state


# ----------------------------------------------------------------------
# State helpers.
# ----------------------------------------------------------------------


def _csv_records(source) -> tuple[list[dict], list[str]]:
    text = source.getvalue().decode("utf-8-sig") if hasattr(source, "getvalue") else Path(source).read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    return rows, [c for c in (reader.fieldnames or []) if c]


def _template_rows(kind: str) -> list[dict]:
    rows, columns = _csv_records(TEMPLATES / f"{kind}.csv")
    return rename_columns(rows, match_columns(columns, kind))


def example_event() -> EventState:
    """The example dinner from templates/, with no schedule yet."""
    state = EventState(title="Example dinner", hosts=_template_rows("hosts"), fams=_template_rows("fams"))
    normalize_state(state)
    return state


def _hash(state: EventState) -> str:
    return hashlib.sha256(save_event(state).encode()).hexdigest()


def _frame(rows: list[dict], columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame([{c: r.get(c, "") for c in columns} for r in rows], columns=columns, dtype="object")


def _reset_editors() -> None:
    ss["editor_version"] = ss.get("editor_version", 0) + 1


def _scroll(anchor: str, message: str | None = None, kind: str = "success") -> None:
    """After the rerun, scroll to anchor and show message there."""
    ss["scroll_to"] = anchor
    if message:
        ss["notes"] = {anchor: (kind, message)}


def _anchor(name: str) -> None:
    st.markdown(f'<div id="{name}"></div>', unsafe_allow_html=True)
    note = ss.get("notes", {}).get(name)
    if note:
        getattr(st, note[0])(note[1])


def _release_date() -> str:
    d = dt.date.fromisoformat(RELEASE_DATE)
    return f"{d:%B} {d.day}, {d.year}"


def _now_text() -> str:
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(st.context.timezone) if st.context.timezone else None
    except Exception:
        tz = None
    return dt.datetime.now(tz).strftime("%I:%M %p").lstrip("0")


if "event" not in ss:
    ss["event"] = example_event()
    ss["editor_version"] = 0
    ss["saved_hash"] = _hash(ss["event"])
event: EventState = ss["event"]


# ----------------------------------------------------------------------
# Sidebar: event settings, save and load, spreadsheets.
# ----------------------------------------------------------------------


def _mark_saved() -> None:
    ss["saved_hash"] = _hash(ss["event"])
    ss["saved_at"] = _now_text()


def _start_over(state: EventState, message: str) -> None:
    ss["event"] = state
    ss["saved_hash"] = _hash(state)
    for k in ("saved_at", "rounds_msg", "pending_upload", "undo_upload", "solve_error", "confirm_start"):
        ss.pop(k, None)
    ss["rounds_v"] = ss.get("rounds_v", 0) + 1
    _reset_editors()
    _scroll("ro-top", message)
    st.rerun()


def sidebar() -> None:
    with st.sidebar:
        st.header("Event")
        event.title = st.text_input("Event name", event.title)
        top = max_rounds(event)
        rounds = st.number_input("Rounds", min_value=1, value=event.rounds, step=1, key=f"rounds_{ss.get('rounds_v', 0)}",
                                 help="How many times the hosts move. Each fam meets a different host every round.")
        if int(rounds) > top:
            event.rounds = top
            ss["rounds_v"] = ss.get("rounds_v", 0) + 1
            ss["rounds_msg"] = rounds_limit_text(event) + f" Rounds is set to {top}."
            st.rerun()
        elif int(rounds) != event.rounds:
            event.rounds = int(rounds)
            ss.pop("rounds_msg", None)
            event.finished = min(event.finished, event.rounds - 1)
        if ss.get("rounds_msg"):
            st.warning(ss["rounds_msg"])
        event.one_weak_round = st.checkbox(
            "No fam gets more than one weak round",
            value=event.one_weak_round,
            help="A weak round is a host who shares none of the fam's interests, or no host at all.",
        )
        with st.expander("Times for the run sheet"):
            event.start_time = st.text_input("Doors open at", event.start_time, placeholder="6:30 PM",
                                             help="Leave blank to write the times on the run sheet by hand.")
            event.round_minutes = int(st.number_input("Minutes per round", min_value=5, max_value=120,
                                                      value=int(event.round_minutes), step=5))

        st.header("Save your work")
        st.download_button(
            "Save event file (keep this to continue later)", save_event(event),
            file_name=f"{event.title or 'event'}.rotation.json", mime="application/json", width="stretch",
            on_click=_mark_saved, key="save_event",
            help="Downloads one file with your tables, rules, cancellations, and schedules. Open it later to pick up where you left off.",
        )
        if _hash(event) == ss.get("saved_hash"):
            st.caption(f"Saved at {ss['saved_at']}." if ss.get("saved_at") else "No changes since this event was opened.")
        else:
            st.caption(":orange[Unsaved changes.] Save the event file to keep them. Leaving or refreshing the page loses them.")
        loaded = st.file_uploader("Open a saved event file", type="json", key="load_event")
        if loaded is not None and ss.get("loaded_file") != loaded.file_id:
            ss["loaded_file"] = loaded.file_id
            try:
                state = load_event(loaded.getvalue())
            except SheetError as err:
                st.error(err.problems[0])
            else:
                _start_over(state, f"Opened {loaded.name}.")
        st.download_button(
            "Hand off to next year", save_event(handoff_event(event)),
            file_name=f"{event.title or 'event'} handoff.rotation.json", mime="application/json", width="stretch",
            key="handoff",
            help="An event file for next year's coordinator: the same host tables, fams, tags, and rules, "
                 "without student names, cancellations, or schedules.",
        )

        st.header("Start")
        if st.button("Load the example dinner", key="start_example", width="stretch"):
            ss["confirm_start"] = "example"
        if st.button("Start a blank event", key="start_blank", width="stretch"):
            ss["confirm_start"] = "blank"
        if ss.get("confirm_start"):
            kind = ss["confirm_start"]
            st.warning("This replaces the event on the page." + ("" if _hash(event) == ss.get("saved_hash") else " Your unsaved changes will be lost."))
            c1, c2 = st.columns(2)
            if c1.button("Replace", key="confirm_start_btn", type="primary", width="stretch"):
                if kind == "example":
                    _start_over(example_event(), "Loaded the example dinner: 10 host tables and 10 fams. Click Apply and find the best schedule.")
                else:
                    _start_over(EventState(title="New event", hosts=[], fams=[]), "Started a blank event. Add host tables and fams, or upload them.")
            if c2.button("Keep mine", key="cancel_start_btn", width="stretch"):
                ss.pop("confirm_start")
                st.rerun()
        st.download_button("Download the example event", save_event(example_event()), file_name="example.rotation.json",
                           mime="application/json", width="stretch", key="download_example",
                           help="A finished example to look at or practice with. Open it with Open a saved event file.")

        st.header("Start from a spreadsheet")
        st.caption(
            "Fill in a template in Google Sheets or Excel, then export it as CSV and upload it here. "
            "A Google Forms export works too: you pick which column holds what. "
            "Tags and interests are keywords separated by commas or semicolons. "
            "Fams can be one row per fam, or one row per student with the fam name on each row."
        )
        c1, c2 = st.columns(2)
        c1.download_button("Hosts template", template_csv("hosts"), file_name="hosts_template.csv", mime="text/csv", width="stretch")
        c2.download_button("Fams template", template_csv("fams"), file_name="fams_template.csv", mime="text/csv", width="stretch")
        for label, key, kind in [("Upload host tables (CSV)", "up_hosts", "hosts"), ("Upload fams (CSV)", "up_fams", "fams")]:
            up = st.file_uploader(label, type="csv", key=key)
            if up is not None and ss.get(f"{key}_id") != up.file_id:
                ss[f"{key}_id"] = up.file_id
                rows, columns = _csv_records(up)
                ss["pending_upload"] = {"kind": kind, "name": up.name, "rows": rows, "columns": columns,
                                        "mapping": match_columns(columns, kind), "id": up.file_id}
                _scroll("ro-upload")
                st.rerun()


# ----------------------------------------------------------------------
# Upload preview with confirm and undo.
# ----------------------------------------------------------------------


NOT_IN_FILE = "(not in this file)"


def prepared_upload(pending: dict) -> tuple[list[dict], list[str], list[str]]:
    """The rows an upload would put in the table, with its problems and notices."""
    kind = pending["kind"]
    problems, notices, mapping = column_report(pending["columns"], kind, pending["mapping"])
    rows = [r for r in rename_columns(pending["rows"], mapping) if any((v or "").strip() for v in r.values())]
    rows, skipped = drop_example_rows(rows)
    if skipped:
        notices.append(f"Skipped {skipped} example row{'s' if skipped > 1 else ''} from the template.")
    if kind == "fams":
        rows, grouped = group_student_rows(rows)
        if grouped:
            notices.append(f"Each row looked like one student, so {grouped} students were grouped into {len(rows)} fams by fam name.")
    return rows, problems, notices


def upload_preview() -> None:
    _anchor("ro-upload")
    pending = ss.get("pending_upload")
    if pending:
        kind = pending["kind"]
        noun = "host tables" if kind == "hosts" else "fams"
        current = len(event.hosts if kind == "hosts" else event.fams)
        with st.container(border=True):
            st.markdown(f"**{pending['name']}**: {len(pending['rows'])} rows. Check which column holds what.")
            st.caption("Columns you do not choose are left out, so a form's email or phone column is never kept.")
            options = [NOT_IN_FILE] + pending["columns"]
            cols = st.columns(len(FILE_COLUMNS_OF[kind]))
            for box, ours in zip(cols, FILE_COLUMNS_OF[kind]):
                theirs = pending["mapping"].get(ours)
                pick = box.selectbox(FRIENDLY[ours], options, index=options.index(theirs) if theirs in options else 0,
                                     key=f"map_{pending.get('id', pending['name'])}_{ours}")
                if pick == NOT_IN_FILE:
                    pending["mapping"].pop(ours, None)
                else:
                    pending["mapping"][ours] = pick
            rows, problems, notices = prepared_upload(pending)
            for p in problems:
                st.error(p)
            for n in notices:
                st.info(n)
            if rows and not problems:
                st.dataframe(pd.DataFrame(rows[:5]).rename(columns=FRIENDLY), hide_index=True, width="stretch")
            c1, c2 = st.columns(2)
            if c1.button(f"Replace {current} {noun} with these {len(rows)}", key="confirm_upload", type="primary",
                         disabled=bool(problems) or not rows, width="stretch"):
                ss["undo_upload"] = {"kind": kind, "rows": list(event.hosts if kind == "hosts" else event.fams), "name": pending["name"]}
                if kind == "hosts":
                    event.hosts = normalize_table(rows, HOST_COLUMNS, "host_id", "h")
                else:
                    event.fams = normalize_table(rows, FAM_COLUMNS, "fam_id", "fam_")
                ss.pop("pending_upload")
                _reset_editors()
                _scroll("ro-upload", f"Replaced the {noun} with {len(rows)} rows from {pending['name']}.")
                st.rerun()
            if c2.button("Cancel", key="cancel_upload", width="stretch"):
                ss.pop("pending_upload")
                st.rerun()
    undo = ss.get("undo_upload")
    if undo and not pending:
        c1, c2 = st.columns([4, 1])
        c1.caption(f"The {'host tables were' if undo['kind'] == 'hosts' else 'fams were'} replaced from {undo['name']}.")
        if c2.button("Undo upload", key="undo_upload_btn", width="stretch"):
            setattr(event, undo["kind"], undo["rows"])
            ss.pop("undo_upload")
            _reset_editors()
            _scroll("ro-upload", "Upload undone. Your previous table is back.")
            st.rerun()


# ----------------------------------------------------------------------
# Tables.
# ----------------------------------------------------------------------


def tables() -> None:
    v = ss["editor_version"]
    host_labels = [r["table_label"] for r in event.hosts if r.get("table_label")]
    fam_labels = [r["fam_label"] for r in event.fams if r.get("fam_label")]
    with st.form("tables", border=False):
        st.subheader("1. Host tables")
        st.caption("One row per host table. Tags are keywords separated by commas or semicolons. Blank tags are fine while a host has not replied. Double-click a cell to edit it; the last row adds a new one.")
        hosts_df = st.data_editor(
            _frame(event.hosts, HOST_COLUMNS), num_rows="dynamic", width="stretch", height=EDITOR_HEIGHT, key=f"hosts_{v}",
            column_order=["table_label", "host_name", "tags"],
            column_config={
                "table_label": st.column_config.TextColumn("Host table name", width="medium", default=""),
                "host_name": st.column_config.TextColumn("Alum's name", width="medium", default="", help="Optional. Printed on host cards only."),
                "tags": st.column_config.TextColumn("Tags", width="large", default=""),
            },
        )
        st.subheader("2. Fams")
        st.caption("One row per fam. Table number is the number on the table in the room; blank ones get the next free number. Students is optional, names separated by semicolons, for the find-your-table page.")
        fams_df = st.data_editor(
            _frame(event.fams, FAM_COLUMNS), num_rows="dynamic", width="stretch", height=EDITOR_HEIGHT, key=f"fams_{v}",
            column_order=["table_number", "fam_label", "size", "interests", "students"],
            column_config={
                "table_number": st.column_config.TextColumn("Table number", width="small", default=""),
                "fam_label": st.column_config.TextColumn("Fam name", width="medium", default=""),
                "size": st.column_config.TextColumn("Size", width="small", default=""),
                "interests": st.column_config.TextColumn("Interests", width="medium", default=""),
                "students": st.column_config.TextColumn("Students", width="medium", default=""),
            },
        )
        st.subheader("3. Pairing rules (optional)")
        st.caption(
            "must meet: the pair meets once, in one of the listed rounds (blank means any round). "
            "never meet: the pair never meets in the listed rounds (blank means never). "
            "only in rounds: the host comes only for the listed rounds; leave the fam blank. "
            "Write rounds as 1 or 1, 2."
        )
        rules_df = st.data_editor(
            _frame(event.rules, RULE_COLUMNS), num_rows="dynamic", width="stretch", key=f"rules_{v}",
            column_config={
                "rule": st.column_config.SelectboxColumn("Rule", options=list(RULE_KINDS), default=None, width="medium"),
                "host_table": st.column_config.SelectboxColumn("Host table", options=host_labels, width="medium"),
                "fam": st.column_config.SelectboxColumn("Fam", options=fam_labels, width="medium"),
                "rounds": st.column_config.TextColumn("Rounds", default="", width="small", help="For example 1, or 1, 2"),
            },
        )
        st.caption("Your edits count once you click a button below.")
        c1, c2 = st.columns(2)
        apply = c1.form_submit_button("Apply changes", width="stretch")
        solve = c2.form_submit_button(
            "Apply and re-plan" if event.plan else "Apply and find the best schedule", type="primary", width="stretch"
        )
    if apply or solve:
        event.hosts = normalize_table(hosts_df.to_dict("records"), HOST_COLUMNS, "host_id", "h")
        event.fams = normalize_table(fams_df.to_dict("records"), FAM_COLUMNS, "fam_id", "fam_")
        event.rules = normalize_table(rules_df.to_dict("records"), RULE_COLUMNS, None, "")
        _reset_editors()
        ss["want_solve"] = bool(solve)
        _scroll("ro-checks")
        st.rerun()


def checks() -> list[str]:
    """Show every problem and warning next to the tables; return the problems."""
    _anchor("ro-checks")
    inputs = check_inputs(event)
    problems = list(inputs.problems)
    solve_error = ss.get("solve_error")
    if solve_error and solve_error[0] == fingerprint(event):
        if ss.get("solve_error_where") == "tables":
            problems.append(solve_error[1])
    else:
        ss.pop("solve_error", None)  # its cause is gone
    if problems:
        st.error("Please fix these first:\n\n" + "\n".join(f"- {p}" for p in problems))
    for w in inputs.warnings:
        st.warning(w)
    for i, miss in enumerate(near_misses(event.hosts, event.fams)):
        c1, c2 = st.columns([4, 1])
        c1.info(f"Did you mean the same thing by {' / '.join(miss.spellings)}? Only exact matches add to a score.")
        if c2.button(f"Use {miss.suggestion!r} everywhere", key=f"spell_{i}_{miss.suggestion}"):
            apply_spelling(event, miss)
            _reset_editors()
            _scroll("ro-checks")
            st.rerun()
    gone = removed_rows(event) if event.finished > 0 else []
    if gone:
        c1, c2 = st.columns([4, 1])
        c1.error(
            f"You removed {', '.join(gone)}, but rounds have already happened, so the schedule would no longer match "
            "what happened. Restore the rows, then use Cancel a host or Cancel a fam below."
        )
        if c2.button("Restore removed rows", key="restore"):
            restored = restore_removed_rows(event)
            _reset_editors()
            _scroll("ro-checks", f"Restored {', '.join(restored)} in "
                    + ("its original place." if len(restored) == 1 else "their original places."))
            st.rerun()
        return problems + ["removed rows"]
    return problems


def solve(keep_printed: bool, where: str) -> bool:
    try:
        with st.spinner("Solving"):
            solve_event(event, keep_printed=keep_printed)
        ss.pop("solve_error", None)
        return True
    except SheetError as err:
        ss["solve_error"] = (fingerprint(event), "; ".join(err.problems))
    except InfeasibleProblemError as err:
        ss["solve_error"] = (fingerprint(event), str(err))
    ss["solve_error_where"] = where
    return False


# ----------------------------------------------------------------------
# Schedule and printouts.
# ----------------------------------------------------------------------


def results(problems: list[str]) -> None:
    _anchor("ro-schedule")
    st.subheader("4. Schedule")
    st.caption(SCORE_LINE)
    plan = event.plan
    if plan is None:
        st.info("Click Apply and find the best schedule above.")
        return
    current = is_current(event) and not problems
    if not current:
        st.warning(
            "Out of date: the tables, rules, settings, or cancellations changed since this schedule was made. "
            + ("Fix the problems above, then click Re-plan." if problems else "Click Apply and re-plan above, or Re-plan below.")
            + " Downloads are hidden until the schedule is up to date."
        )
    with st.container(border=not current):
        c1, c2, c3 = st.columns(3)
        c1.metric("Total match score", plan.total_score, help="The sum of every pairing's score. Higher is better.")
        c2.metric("Proven best possible", "Yes" if plan.proven_optimal else "Not proven",
                  help="Yes means no other schedule with these tables and rules scores higher.")
        c3.metric("Weak pairings", len(plan.zero_slots()), help="Pairings where the host and fam share no tags, plus open tables.")
        for w in plan.warnings:
            if w.startswith("Fairness check"):
                st.warning(w)
        with st.expander("Notes on tags"):
            for w in plan.warnings:
                if not w.startswith("Fairness check"):
                    st.write(w)
        rows = pd.DataFrame(schedule_rows(plan))
        tabs = st.tabs([f"Round {r}" for r in range(1, plan.rounds + 1)] + ["Host view"])
        for r, tab in enumerate(tabs[:-1], start=1):
            tab.dataframe(rows[rows["round"] == r].drop(columns="round").rename(columns=COLUMN_NAMES), hide_index=True, width="stretch")
        tabs[-1].dataframe(pd.DataFrame(host_view_rows(plan)).rename(columns=lambda c: COLUMN_NAMES.get(c, c.capitalize())),
                           hide_index=True, width="stretch")
    if not current:
        return
    st.markdown("**Print these four for the night**")
    d = st.columns(4)
    d[0].download_button("Seating chart", seating_chart_html(plan, title=event.title), file_name="seating_chart.html",
                         mime="text/html", width="stretch", help="One page per round for the room, then a find-your-table page.")
    d[1].download_button("Host cards", host_cards_html(plan, title=event.title), file_name="host_cards.html",
                         mime="text/html", width="stretch", help="Half a page per host: where to go each round and what to talk about.")
    d[2].download_button("Table tents", table_tents_html(plan), file_name="table_tents.html", mime="text/html",
                         width="stretch", help="A big table number to fold and stand on each fam's table.")
    d[3].download_button("Run sheet", run_sheet_html(plan, title=event.title, start_time=event.start_time,
                                                     round_minutes=event.round_minutes),
                         file_name="run_sheet.html", mime="text/html", width="stretch",
                         help="For you and the MC: a timeline for the night and check-in lists.")
    st.download_button("Schedule as a spreadsheet (CSV)", schedule_csv(plan), file_name="schedule.csv", mime="text/csv",
                       help="Every round and table, to open in Google Sheets or Excel. Not needed for printing.")
    _anchor("ro-printed")
    c1, c2 = st.columns([1, 3])
    if c1.button("Mark as printed", key="mark_printed"):
        event.printed = event.plan
        _scroll("ro-printed", "Marked as printed. Later changes will be listed against this version.")
        st.rerun()
    c2.caption(
        "Printed version: " + ("set. Changes below are listed against it." if event.printed else "none yet. Click Mark as printed after you print.")
        + " Open each downloaded page in your browser and print it on US Letter."
    )


def checklist() -> None:
    if not event.hosts and not event.fams:
        return
    items = before_the_night(event, saved=_hash(event) == ss.get("saved_hash"))
    left = sum(1 for i in items if i.status == "todo")
    with st.expander("Before the night: " + (f"{left} thing{'s' if left != 1 else ''} left to do" if left else "all done"),
                     expanded=bool(event.plan) and left > 0):
        mark = {"done": ":green[Done]", "todo": ":orange[To do]", "optional": ":gray[Optional]"}
        for item in items:
            st.markdown(f"{mark[item.status]}: {item.text}")


# ----------------------------------------------------------------------
# Changes on the night.
# ----------------------------------------------------------------------


def night(problems: list[str]) -> None:
    plan = event.plan
    if plan is None:
        return
    st.subheader("5. Changes on the night")
    st.caption("In this order: set the rounds that already happened, cancel anyone who can't come, then click Re-plan. "
               "Finished rounds never change. Then reprint only the pages listed under Reprint.")
    low = max(plan.locked_rounds or [0])
    finished = st.number_input(
        "Rounds already finished", min_value=0, max_value=plan.rounds - 1, value=min(event.finished, plan.rounds - 1),
        step=1, key=f"finished_{ss['editor_version']}",
    )
    if finished < low:
        with st.container(border=True):
            st.warning(
                f"Round {low} is locked because you re-planned after it finished. Un-finishing it lets the solver change "
                f"round {low} again, so printed host cards for that round may no longer match."
            )
            if st.button(f"Un-finish round {low}", key="unfinish"):
                plan.locked_rounds = [r for r in plan.locked_rounds if r <= finished]
                event.finished = int(finished)
                _scroll("ro-night", f"Round {low} is no longer finished.")
                st.rerun()
    elif low:
        st.caption(f"Rounds 1 to {low} are locked because you re-planned after they finished." if low > 1 else
                   "Round 1 is locked because you re-planned after it finished. To change it again, lower this number.")
    event.finished = max(int(finished), low)
    _anchor("ro-night")
    open_rounds = list(range(event.finished + 1, plan.rounds + 1))
    hosts_by_name = {h.name: h.host_id for h in plan.hosts}
    fams_by_name = {f.name: f.group_id for f in plan.fams}
    if open_rounds:
        st.markdown("**Someone can't come**")
        for kind, names, store in [("host", hosts_by_name, event.cancel_hosts), ("fam", fams_by_name, event.cancel_fams)]:
            c1, c2, c3 = st.columns([3, 1, 1.4], vertical_alignment="bottom")
            who = c1.selectbox(f"Cancel a {kind}", list(names), key=f"cancel_{kind}_name")
            first = c2.selectbox("from round", open_rounds, key=f"cancel_{kind}_round_{event.finished}")
            if c3.button(f"Cancel {kind}", key=f"cancel_{kind}_btn", width="stretch"):
                store[names[who]] = int(first)
                _scroll("ro-cancellations", f"{who} is cancelled from round {first}. Click Re-plan to update the schedule.", "info")
                st.rerun()
    _anchor("ro-cancellations")
    cancelled = [("host", h, r, plan.host_name(h) if any(x.host_id == h for x in plan.hosts) else h) for h, r in event.cancel_hosts.items()]
    cancelled += [("fam", f, r, plan.fam_name(f) if any(x.group_id == f for x in plan.fams) else f) for f, r in event.cancel_fams.items()]
    if cancelled:
        st.markdown("**Cancellations**")
    for kind, ident, r, name in cancelled:
        c1, c2 = st.columns([4, 1])
        applied = r in (plan.host_away if kind == "host" else plan.fam_away).get(ident, [])
        c1.write(f"{name}: cancelled from round {r}" + ("" if applied else " (waiting for Re-plan)"))
        if r > event.finished and c2.button("Undo", key=f"undo_{kind}_{ident}"):
            (event.cancel_hosts if kind == "host" else event.cancel_fams).pop(ident, None)
            _scroll("ro-cancellations")
            st.rerun()
    mode = st.radio(
        "How to re-plan",
        ["Keep the printed schedule where possible", "Re-plan from scratch (nothing printed yet)"],
        key="mode", horizontal=True,
    )
    if st.button("Re-plan", type="primary", disabled=bool(problems), key="replan_btn", width="stretch"):
        if solve(keep_printed=mode.startswith("Keep"), where="night"):
            _scroll("ro-changes", "Schedule updated.")
        else:
            _scroll("ro-night-error")
        st.rerun()
    _anchor("ro-night-error")
    err = ss.get("solve_error")
    if err and err[0] == fingerprint(event) and ss.get("solve_error_where") == "night":
        st.error(err[1])
    changes_since_printed()


def changes_since_printed() -> None:
    _anchor("ro-changes")
    printed, plan = event.printed, event.plan
    st.markdown("**What changed since the printed version**")
    if printed is None:
        st.caption("Nothing is marked as printed yet. Click Mark as printed after you print, and changes will be listed here.")
        return
    tables = {f.group_id: f.table_number for f in plan.fams}
    changes = plan_changes(printed, plan)
    if changes:
        st.dataframe(
            pd.DataFrame([
                {"Round": c.round_number, "Table": tables.get(c.fam_id), "Fam": plan.fam_name(c.fam_id),
                 "Printed": slot_text(printed, c.round_number, c.fam_id), "Now": slot_text(plan, c.round_number, c.fam_id)}
                for c in changes
            ]),
            hide_index=True, width="stretch",
        )
    else:
        st.write("Nothing changed.")
    out = reprint_list(printed, plan)
    st.markdown("**Reprint:** " + ("; ".join(out.describe(plan)) or "nothing."))
    if not is_current(event):
        return
    c1, c2, c3 = st.columns(3)
    if out.host_ids:
        c1.download_button("Reprint host cards", host_cards_html(plan, host_ids=out.host_ids, title=event.title),
                           file_name="host_cards_reprint.html", mime="text/html", key="reprint_cards")
    if out.seating_chart:
        c2.download_button("Reprint seating chart pages",
                           seating_chart_html(plan, title=event.title, rounds=out.seating_rounds or [], finder=out.finder_page),
                           file_name="seating_chart_reprint.html", mime="text/html", key="reprint_chart")
    if out.fam_ids:
        c3.download_button("Reprint table tents", table_tents_html(plan, fam_ids=out.fam_ids),
                           file_name="table_tents_reprint.html", mime="text/html", key="reprint_tents")


# ----------------------------------------------------------------------
# Page.
# ----------------------------------------------------------------------


def browser_fixes() -> None:
    config = {"dirty": _hash(event) != ss.get("saved_hash"), "scrollTo": ss.pop("scroll_to", None)}
    components.html(f"<script>window.ROTATION_CONFIG = {json.dumps(config)};\n{FIXES_JS}</script>", height=0)


START_HERE = """
**1. Your tables.** The page opens with an example dinner so you can try everything first. For your own event,
click **Start a blank event** in the sidebar, or fill in the **Hosts template** and **Fams template** and upload them.
A Google Forms export works too.

**2. Pairing rules (optional).** Add a rule when a host must meet a fam, must never meet one, or only comes for some rounds.

**3. Find the schedule.** Click **Apply and find the best schedule**. Read any warnings, and the
**Before the night** checklist under the schedule.

**4. Print.** Download and print the **seating chart**, **host cards**, **table tents**, and **run sheet**.
Open each downloaded page in your browser and print it on US Letter. Then click **Mark as printed**.

**5. Save.** Click **Save event file** in the sidebar and keep the file. The page does not remember your event
after you close it; the file does. Open it again with **Open a saved event file**.

**6. On the night.** If someone cancels: set **Rounds already finished**, click **Cancel host** or **Cancel fam**,
then **Re-plan**. Reprint only the pages listed under **Reprint**.

**7. Next year.** Click **Hand off to next year** for a copy without student names or the night's changes.
"""

GLOSSARY = """
- **Host table**: one alum (or a pair) who hosts a topic, such as Pharmacy. Host tables move each round.
- **Alum**: the person hosting a host table. Their name is printed on host cards only.
- **Fam**: a group of admitted students seated at one numbered table all night.
- **Round**: one block of conversation. Between rounds every host moves to a new fam.
- **Tags and interests**: keywords for a host's topics and a fam's interests. Each tag they share raises the score.
- **Score**: how well a host matches a fam, from 0 (nothing shared) to 100 (the same keywords).
  The tool finds the schedule with the highest total score.
- **Weak round**: a round where a fam's host shares none of its interests, or no host comes to the fam.
- **Open table**: a fam with no host for a round, when there are more fams than host tables.
- **No table this round**: a host with no fam for a round, when there are more host tables than fams.
- **Pairing rule**: must meet, never meet, or only in rounds. Rules always hold; the score decides the rest.
- **Finished round**: a round that already happened. Re-planning never changes it.
- **Printed version**: the schedule you marked as printed. Changes are listed against it, so you reprint only what changed.
- **Event file**: the file Save event file downloads. It holds everything, and it is the only copy.
"""


def guide() -> None:
    with st.expander("Start here: how to plan a dinner in 7 steps", expanded=event.plan is None):
        st.markdown(START_HERE)
    with st.expander("Words used here"):
        st.markdown(GLOSSARY)


def footer() -> None:
    st.divider()
    st.caption(f"Rotation Optimizer {__version__}, updated {_release_date()}. Your event is kept only while this "
               "tab is open. Save the event file to keep it.")


def main() -> None:
    _anchor("ro-top")
    st.title("Rotation Optimizer")
    st.write(
        "Plan which host table visits which fam in each round of a rotation dinner. Fams stay seated; hosts move, "
        "and no fam meets the same host twice. The tool matches hosts to fams by shared interests, prints what "
        "you need for the night, and re-plans when someone cancels."
    )
    guide()
    key = f"finished_{ss['editor_version']}"
    if key in ss and event.plan is not None:
        event.finished = max(int(ss[key]), max(event.plan.locked_rounds or [0]))
    sidebar()
    upload_preview()
    tables()
    if ss.pop("want_solve", False):
        blocked = check_inputs(event).problems or (event.finished > 0 and removed_rows(event))
        if not blocked and solve(keep_printed=has_started(event) or event.printed is not None, where="tables"):
            _scroll("ro-schedule", "Schedule updated.")
            st.rerun()
    problems = checks()
    results(problems)
    checklist()
    night(problems)
    footer()
    ss.pop("notes", None)
    browser_fixes()


try:
    main()
except Exception as err:  # keep the event; never show a traceback to a coordinator
    st.error(
        "Something went wrong on this page, but your event is safe: the tables, rules, cancellations, and "
        "schedule are kept. Use Save event in the sidebar to keep a copy, then reload the page. "
        f"Details for the developer: {type(err).__name__}: {err}"
    )
