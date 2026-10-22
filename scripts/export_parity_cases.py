"""Write web/test/fixtures/parity.json: what the Python package says for many inputs.

The web app is a TypeScript port of this package. Its tests load this file
and check that the port gives the same answers: the same best total score
for each scheduling case, the same messages, the same printouts byte for
byte, and the same fingerprints. Run it again after changing the Python
package, and commit the new file with the change:

    python scripts/export_parity_cases.py
"""

from __future__ import annotations

import copy
import csv
import json
from pathlib import Path

from rotation_optimizer import (
    host_cards_html,
    host_view_rows,
    plan_changes,
    reprint_list,
    run_sheet_html,
    schedule_csv,
    seating_chart_html,
    slot_text,
    table_tents_html,
)
from rotation_optimizer.event import (
    EventState,
    before_the_night,
    check_inputs,
    fingerprint,
    load_event,
    near_misses,
    normalize_state,
    save_event,
    solve_event,
)
from rotation_optimizer.planning import RuleConflictError, fairness_warnings, host_warnings
from rotation_optimizer.models import Assignment, GuestGroup, Host
from rotation_optimizer.sheets import (
    SheetError,
    column_report,
    group_student_rows,
    match_columns,
    parse_rounds,
)
from rotation_optimizer.solver import InfeasibleProblemError

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "test" / "fixtures" / "parity.json"


def rows(name: str) -> list[dict]:
    return list(csv.DictReader((ROOT / "templates" / name).open(encoding="utf-8-sig")))


def event(hosts, fams, rounds=2, **kw) -> EventState:
    s = EventState(hosts=copy.deepcopy(hosts), fams=copy.deepcopy(fams), rounds=rounds, **kw)
    normalize_state(s)
    return s


def outcome(s: EventState, keep_printed: bool = True) -> dict:
    try:
        plan = solve_event(s, keep_printed=keep_printed)
    except SheetError as err:
        return {"problems": err.problems}
    except InfeasibleProblemError as err:
        return {"error": str(err)}
    return {"total": plan.total_score, "proven": plan.proven_optimal, "kept": plan.kept_slots,
            "spread_penalty": spread_penalty(plan),
            "weak": plan.weak_count(), "warnings_no_fairness": [w for w in plan.warnings if not w.startswith("Fairness")]}


def spread_penalty(plan) -> int:
    """The even-spread penalty the planner minimizes (see solver.py), measured on a finished plan.

    Two equally good schedules can spread the empty rounds differently, but
    they always have the same penalty, so this is what the web app must match.
    """
    total = 0
    every = range(1, plan.rounds + 1)
    sides = [(h.host_id, set(plan.host_away.get(h.host_id, [])) | set(plan.host_limits.get(h.host_id, [])),
              {a.round_number for a in plan.assignments if a.host_id == h.host_id}) for h in plan.hosts]
    sides += [(f.group_id, set(plan.fam_away.get(f.group_id, [])),
               {a.round_number for a in plan.assignments if a.group_id == f.group_id}) for f in plan.fams]
    for _, away, met in sides:
        avail = [r for r in every if r not in away]
        empty = sum(1 for r in avail if r not in met)
        total += sum(max(0, empty - k) for k in range(1, len(avail)))
    return total


def main() -> None:
    practice_h, practice_f = rows("practice_hosts.csv"), rows("practice_fams.csv")
    real_h, real_f = rows("hosts.csv"), rows("fams.csv")
    small_h = [{"table_label": n, "tags": t} for n, t in [
        ("Medicine", "medicine; biology"), ("Law", "law; policy"), ("Tech", "software; data"),
        ("Art", "art; design"), ("Finance", "finance; economics"), ("Teaching", "education; history")]]
    small_f = [{"fam_label": f"Fam {i}", "interests": t} for i, t in enumerate(
        ["biology", "law", "data", "design", "economics", "history", "medicine; data", "art; policy"], start=1)]

    solve_cases = []

    def add(name, s, keep_printed=True):
        before = save_event(s)
        solve_cases.append({"name": name, "event": json.loads(before), "keep_printed": keep_printed, "expect": outcome(s, keep_printed)})

    for r in (1, 2, 3, 4, 6, 10):
        add(f"practice, {r} rounds", event(practice_h, practice_f, r))
    for r in (2, 3):
        add(f"real example, {r} rounds", event(real_h, real_f, r))
    add("6 hosts, 8 fams, 3 rounds", event(small_h, small_f, 3))
    add("6 hosts, 10 practice fams, 3 rounds", event(practice_h[:6], practice_f, 3))
    add("10 hosts, 6 fams, 3 rounds", event(practice_h, practice_f[:6], 3))
    extra_h = practice_h + [{"table_label": "Real Estate", "tags": "real estate; finance"},
                            {"table_label": "Film & TV", "tags": "film; television; writing"}]
    add("12 hosts, 10 fams, 2 rounds", event(extra_h, practice_f, 2))
    add("8 hosts, 10 fams, 3 rounds", event(practice_h[:8], practice_f, 3))
    add("12 hosts, 3 fams, 2 rounds", event(extra_h, practice_f[:3], 2))
    add("12 hosts, 10 fams, one weak round", event(extra_h, practice_f, 2, one_weak_round=True))
    add("only in rounds 1", event(small_h, small_f, 3, rules=[{"rule": "only in rounds", "host_table": "Medicine", "fam": "", "rounds": "1"}]))
    add("only in rounds 1 and 2", event(small_h, small_f, 3, rules=[{"rule": "only in rounds", "host_table": "Medicine", "fam": "", "rounds": "1, 2"}]))
    add("must and never rules", event(practice_h, practice_f, 2, rules=[
        {"rule": "must meet", "host_table": "Pharmacy", "fam": "Bio & Chem", "rounds": "2"},
        {"rule": "never meet", "host_table": "Physician (MD)", "fam": "Cog Sci & Pre-Health", "rounds": ""},
        {"rule": "only in rounds", "host_table": "Academic Mentorship", "fam": "", "rounds": "1"}]))
    add("one weak round", event(practice_h, practice_f, 3, one_weak_round=True))
    add("one weak round, real example", event(real_h, real_f, 2, one_weak_round=True))
    add("conflict: three musts", event(small_h, small_f, 2, rules=[
        {"rule": "must meet", "host_table": h, "fam": "Fam 1", "rounds": ""} for h in ("Medicine", "Law", "Tech")]))
    add("conflict: must against only in rounds", event(small_h, small_f, 3, rules=[
        {"rule": "must meet", "host_table": "Medicine", "fam": "Fam 1", "rounds": "2"},
        {"rule": "only in rounds", "host_table": "Medicine", "fam": "", "rounds": "1"}]))
    add("conflict: never rules leave one fam", event(
        [{"table_label": n, "tags": "x"} for n in ("Pharmacy", "Law", "Art", "Film")],
        [{"fam_label": n, "interests": "x"} for n in ("Red Fam", "Blue Fam", "Gold Fam", "Teal Fam")], 2, rules=[
            {"rule": "must meet", "host_table": "Law", "fam": "Red Fam", "rounds": "2"},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Blue Fam", "rounds": ""},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Gold Fam", "rounds": ""},
            {"rule": "never meet", "host_table": "Pharmacy", "fam": "Teal Fam", "rounds": ""},
            {"rule": "must meet", "host_table": "Art", "fam": "Blue Fam", "rounds": "1"}]))
    add("input problems", event([{"table_label": "", "tags": "a"}, {"table_label": "Law", "tags": ""}, {"table_label": "law", "tags": "x"}],
                                [{"fam_label": "A", "size": "six", "table_number": "0"}, {"fam_label": "B", "table_number": "3"},
                                 {"fam_label": "C", "table_number": "3"}], 2,
                                rules=[{"rule": "must meet", "host_table": "Nope", "fam": "A", "rounds": ""},
                                       {"rule": "never meet", "host_table": "Law", "fam": "A", "rounds": "5"},
                                       {"rule": "only in rounds", "host_table": "Law", "fam": "", "rounds": ""}]))

    # Night of: a printed plan from Python, then a cancellation and a re-plan.
    for r in (2, 3, 4):
        base = event(practice_h, practice_f, r)
        solve_event(base)
        base.printed = base.plan
        for kind, ident in [("host", "h02"), ("host", "h07"), ("fam", "fam_03"), ("fam", "fam_10")]:
            s = copy.deepcopy(base)
            s.finished = 1
            (s.cancel_hosts if kind == "host" else s.cancel_fams)[ident] = 2
            add(f"{r} rounds, round 1 finished, cancel {kind} {ident} from round 2", s)
        s = copy.deepcopy(base)
        s.cancel_fams = {"fam_05": 2}
        add(f"{r} rounds, from scratch with a cancellation", s, keep_printed=False)
    s = event(practice_h, practice_f, 3)
    solve_event(s)
    s.printed = s.plan
    s.rounds = 2
    add("lower rounds after printing", s)

    # Messages and helpers.
    messages = {
        "check_inputs": [],
        "parse_rounds": [],
        "near_misses": [],
        "match_columns": [],
        "column_report": [],
        "group_student_rows": [],
        "fairness": [],
        "host_warnings": [],
        "fingerprint": [],
        "before_the_night": [],
    }
    for case in solve_cases[:6] + solve_cases[-12:]:
        st = load_event(json.dumps(case["event"]))
        inp = check_inputs(st)
        messages["check_inputs"].append({"event": case["event"], "problems": inp.problems, "warnings": inp.warnings})
        messages["fingerprint"].append({"event": case["event"], "fingerprint": fingerprint(st)})
    bad = solve_cases[[c["name"] for c in solve_cases].index("input problems")]
    st = load_event(json.dumps(bad["event"]))
    inp = check_inputs(st)
    messages["check_inputs"].append({"event": bad["event"], "problems": inp.problems, "warnings": inp.warnings})
    for text, n in [("1", 2), ("1, 2", 3), ("1;2", 3), ("1 and 2", 3), ("2.0", 2), ("", 2), ("3", 2), ("1.5", 2), ("first", 2), ("0", 2)]:
        try:
            messages["parse_rounds"].append({"text": text, "rounds": n, "value": list(parse_rounds(text, n))})
        except ValueError as err:
            messages["parse_rounds"].append({"text": text, "rounds": n, "error": str(err)})
    for hosts, fams in [
        ([{"tags": "pre-med; Math; econ"}], [{"interests": "premed; mathematics; economics; computer science"}]),
        ([{"tags": "medicine; medicines; small business"}], [{"interests": "medicine; small-business; Small Business"}]),
    ]:
        messages["near_misses"].append({"hosts": hosts, "fams": fams,
                                        "out": [[list(m.spellings), m.suggestion] for m in near_misses(hosts, fams)]})
    for columns, kind in [
        (["Host table name", "Alum's name", "Tags"], "hosts"),
        (["host_id", "name", "tags"], "hosts"),
        (["Timestamp", "Email Address", "What is your full name?", "Which career table will you host?", "What topics can you talk about? (pick all)"], "hosts"),
        (["Timestamp", "Email address", "Your name", "Fam", "Table number", "Intended major(s)"], "fams"),
        (["Table number", "Fam name", "Size", "Interests", "Students"], "fams"),
        (["group", "count", "majors", "names"], "fams"),
    ]:
        messages["match_columns"].append({"columns": columns, "kind": kind, "mapping": match_columns(columns, kind)})
        problems, notices, mapping = column_report(columns, kind)
        messages["column_report"].append({"columns": columns, "kind": kind, "problems": problems, "notices": notices, "mapping": mapping})
    for rs in [
        [{"fam_label": "Bio & Chem", "students": "Student 01", "interests": "biology, chemistry", "table_number": "3"},
         {"fam_label": "Bio & Chem", "students": "Student 02", "interests": "Chemistry; pre-med", "table_number": ""},
         {"fam_label": "Humanities", "students": "Student 03", "interests": "history", "table_number": ""}],
        [{"fam_label": "Red", "interests": "law"}, {"fam_label": "Red", "interests": "art"}, {"fam_label": "Blue", "interests": "math"}],
    ]:
        out, n = group_student_rows(rs)
        messages["group_student_rows"].append({"rows": rs, "out": out, "count": n})
    fams = [GuestGroup.make(f"f{i}", name, ["x"]) for i, name in enumerate(["Bio", "Chem", "Physics", "Violet Fam"])]
    real = [Assignment(r, "h1", f"f{i}", score) for i, scores in enumerate([(20, 20), (19, 19), (25, 15)])
            for r, score in zip((1, 2), scores)] + [Assignment(1, "h1", "f3", 10), Assignment(2, "h1", "f0", 0)]
    messages["fairness"].append({"fams": [[f.group_id, f.name] for f in fams], "real": [[a.round_number, a.host_id, a.group_id, a.score] for a in real],
                                 "rounds": 2, "out": fairness_warnings(fams, real, 2, {}, {"h1": "Pharmacy"})})
    real = [Assignment(1, "h1", "f0", 20), Assignment(2, "h1", "f1", 0)]
    messages["fairness"].append({"fams": [[f.group_id, f.name] for f in fams], "real": [[a.round_number, a.host_id, a.group_id, a.score] for a in real],
                                 "rounds": 2, "out": fairness_warnings(fams, real, 2, {}, {"h1": "Pharmacy"})})
    hosts = [Host.make(f"h{i}", name, name, ["x"]) for i, name in enumerate(["Pharmacy", "Law", "Film & TV"], start=1)]
    for away in ({}, {"h3": [1, 2]}, {"h3": [2]}):
        messages["host_warnings"].append({"hosts": [[h.host_id, h.name] for h in hosts], "real": [[1, "h1", "f0", 5], [2, "h2", "f0", 5]],
                                          "rounds": 2, "host_away": away,
                                          "out": host_warnings(hosts, [Assignment(1, "h1", "f0", 5), Assignment(2, "h2", "f0", 5)], 2, away)})

    # Printouts for fixed plans, byte for byte.
    printouts = []
    for case in solve_cases:
        if case["name"] not in ("practice, 2 rounds", "only in rounds 1", "10 hosts, 6 fams, 3 rounds",
                                "3 rounds, round 1 finished, cancel host h02 from round 2", "6 hosts, 8 fams, 3 rounds"):
            continue
        st = load_event(json.dumps(case["event"]))
        if st.plan is None or case["name"].startswith("3 rounds"):
            st = load_event(json.dumps(case["event"]))
            solve_event(st)
        st.start_time = "6:30 PM"
        plan = st.plan
        entry = {
            "name": case["name"], "event": json.loads(save_event(st)),
            "seating_chart": seating_chart_html(plan, title="Example dinner"),
            "seating_chart_round_2": seating_chart_html(plan, title="Example dinner", rounds=[2], finder=False, updated="7:42 PM"),
            "host_cards": host_cards_html(plan, title="Example dinner"),
            "table_tents": table_tents_html(plan),
            "run_sheet": run_sheet_html(plan, title="Example dinner", start_time="6:30 PM", round_minutes=20),
            "run_sheet_blank": run_sheet_html(plan, title="Example dinner"),
            "schedule_csv": schedule_csv(plan),
            "host_view": host_view_rows(plan),
        }
        if st.printed is not None:
            out = reprint_list(st.printed, plan)
            entry["reprint"] = out.describe(plan)
            entry["changes"] = [[c.round_number, c.fam_id, slot_text(st.printed, c.round_number, c.fam_id),
                                 slot_text(plan, c.round_number, c.fam_id)] for c in plan_changes(st.printed, plan)]
        st.printed = plan
        messages["before_the_night"].append({"event": json.loads(save_event(st)), "saved": False,
                                             "items": [[i.status, i.text] for i in before_the_night(st, saved=False)]})
        printouts.append(entry)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"solve": solve_cases, "messages": messages, "printouts": printouts}, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(solve_cases)} solve cases, {len(printouts)} printout sets")


if __name__ == "__main__":
    main()
