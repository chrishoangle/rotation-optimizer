"""One event as a coordinator works on it, and saving it to a single file.

The app keeps an EventState in its session and calls the functions here,
so the logic is testable without Streamlit:

  normalize_table   drop blank rows, fill missing columns, give every row a
                    stable id that survives edits and deletions
  check_inputs      read hosts, fams, and rules, and collect every problem
                    and warning at once
  fingerprint       a hash of everything a plan depends on, to tell when a
                    plan is out of date
  solve_event       plan, or re-plan keeping finished rounds and the printed
                    schedule
  near_misses       tags that differ only by case, spaces, hyphens, or a
                    plural "s", with a suggested single spelling
  save_event / load_event   the whole event as one JSON file
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Iterable

from .models import Assignment, GuestGroup, Host
from .planning import EventPlan, Rule, plan_event
from .sheets import SheetError, clean_rows, fams_from_rows, hosts_from_rows, parse_rule_rows

FILE_FORMAT = "rotation-optimizer-event"
FILE_VERSION = 1

HOST_COLUMNS = ["host_id", "table_label", "host_name", "tags"]
FAM_COLUMNS = ["fam_id", "table_number", "fam_label", "size", "interests", "students"]
RULE_COLUMNS = ["rule", "host_table", "fam", "rounds"]


@dataclass
class EventState:
    """Everything about one event that must survive a rerun, a crash, or a reload."""

    title: str = "Alumni dinner"
    rounds: int = 2
    hosts: list[dict] = field(default_factory=list)
    fams: list[dict] = field(default_factory=list)
    rules: list[dict] = field(default_factory=list)
    finished: int = 0
    cancel_hosts: dict[str, int] = field(default_factory=dict)  # host id: first round missed
    cancel_fams: dict[str, int] = field(default_factory=dict)
    plan: EventPlan | None = None
    plan_inputs: str | None = None  # fingerprint of the inputs the plan was made from
    printed: EventPlan | None = None  # the plan marked as printed, the baseline for changes
    one_weak_round: bool = False  # no fam gets more than one 0-score host or open table
    plan_tables: dict | None = None  # the host and fam rows the plan was made from
    start_time: str = ""  # for the run sheet, for example "6:30 PM"; blank leaves times to fill in
    round_minutes: int = 20  # for the run sheet
    printed_at: str = ""  # when Mark as printed was clicked, for example "7:12 PM"
    arrived: list[str] = field(default_factory=list)  # host ids checked in on the night
    notes: str = ""  # notes for next year's coordinator, kept in the hand-off
    night_log: list[dict] = field(default_factory=list)  # {"at": "7:42 PM", "text": "..."} for each change on the night


@dataclass
class Inputs:
    hosts: list[Host]
    fams: list[GuestGroup]
    rules: list[Rule]
    only_in_rounds: dict[str, list[int]]
    problems: list[str]
    warnings: list[str]


def normalize_table(rows: Iterable[dict], columns: list[str], id_column: str | None, id_prefix: str) -> list[dict]:
    """Clean rows, keep the given columns in order, and give blank ids the next free one."""
    out = []
    rows = clean_rows(rows)
    used = {r.get(id_column, "") for r in rows} if id_column else set()
    n = 1
    for row in rows:
        clean = {c: row.get(c, "") for c in columns}
        for k, v in row.items():
            clean.setdefault(k, v)
        if id_column and not clean[id_column]:
            while f"{id_prefix}{n:02d}" in used:
                n += 1
            clean[id_column] = f"{id_prefix}{n:02d}"
            used.add(clean[id_column])
        out.append(clean)
    return out


def normalize_state(state: EventState) -> None:
    state.hosts = normalize_table(state.hosts, HOST_COLUMNS, "host_id", "h")
    state.fams = normalize_table(state.fams, FAM_COLUMNS, "fam_id", "fam_")
    state.rules = normalize_table(state.rules, RULE_COLUMNS, None, "")


def rounds_limit_text(state: EventState) -> str:
    top = max_rounds(state)
    what = f"host tables ({top})" if len(state.hosts) >= len(state.fams) else f"fams ({top})"
    return f"Rounds can't be more than the number of {what}, or some fam would meet the same host twice."


def max_rounds(state: EventState) -> int:
    """The most rounds possible without any fam meeting the same host twice."""
    return max(len(state.hosts), len(state.fams), 1)


def check_inputs(state: EventState) -> Inputs:
    """Read every table and collect all problems and warnings in one pass."""
    hosts, host_problems, host_warnings = hosts_from_rows(state.hosts)
    fams, fam_problems, fam_warnings = fams_from_rows(state.fams)
    problems = host_problems + fam_problems
    rules: list[Rule] = []
    only: dict[str, list[int]] = {}
    try:
        rules, only = parse_rule_rows(state.rules, hosts, fams, state.rounds)
    except SheetError as err:
        problems += err.problems
    if state.rounds > max_rounds(state):
        problems.append(rounds_limit_text(state))
    return Inputs(hosts, fams, rules, only, problems, host_warnings + fam_warnings)


def fingerprint(state: EventState) -> str:
    """A hash of everything a plan depends on. A different hash means the plan is out of date."""
    payload = {
        "rounds": state.rounds,
        "hosts": clean_rows(state.hosts),
        "fams": clean_rows(state.fams),
        "rules": clean_rows(state.rules),
        "cancel_hosts": state.cancel_hosts,
        "cancel_fams": state.cancel_fams,
    }
    if state.one_weak_round:
        # Added only when on, so event files saved before this setting existed stay up to date.
        payload["one_weak_round"] = True
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def is_current(state: EventState) -> bool:
    return state.plan is not None and state.plan_inputs == fingerprint(state)


def has_started(state: EventState) -> bool:
    return state.finished > 0 or bool(state.plan and state.plan.locked_rounds)


def solve_event(state: EventState, *, keep_printed: bool = True) -> EventPlan:
    """Plan the event, or re-plan it once a plan exists.

    Finished rounds are locked exactly as they happened. With keep_printed,
    the remaining rounds keep the printed schedule (or the current plan if
    nothing is marked printed) wherever the changes allow. Cancellations
    and "only in rounds" rules are applied together. Raises SheetError with
    every input problem, or InfeasibleProblemError in plain words.
    """
    normalize_state(state)
    inputs = check_inputs(state)
    if inputs.problems:
        raise SheetError(inputs.problems)
    host_away: dict[str, set[int]] = {}
    for h, first in state.cancel_hosts.items():
        host_away.setdefault(h, set()).update(range(first, state.rounds + 1))
    fam_away = {f: set(range(first, state.rounds + 1)) for f, first in state.cancel_fams.items()}
    locked: list[tuple[int, str, str]] = []
    keep: list[tuple[int, str, str]] = []
    if state.plan is not None:
        done = max([state.finished, *state.plan.locked_rounds])
        state.finished = done
        locked = [(a.round_number, a.host_id, a.group_id) for a in state.plan.assignments if a.round_number <= done]
        if keep_printed:
            base = state.printed or state.plan
            keep = [s for s in base.slots() if s[0] > done]
    plan = plan_event(
        inputs.hosts,
        inputs.fams,
        state.rounds,
        rules=inputs.rules,
        host_away={h: sorted(rs) for h, rs in host_away.items() if rs},
        fam_away={f: sorted(rs) for f, rs in fam_away.items() if rs},
        locked=locked,
        keep=keep,
        host_limits=inputs.only_in_rounds,
        weak_limit=1 if state.one_weak_round else None,
    )
    plan.warnings = inputs.warnings + plan.warnings
    state.plan = plan
    state.plan_inputs = fingerprint(state)
    state.plan_tables = {"hosts": copy.deepcopy(state.hosts), "fams": copy.deepcopy(state.fams)}
    return plan


def restore_removed_rows(state: EventState) -> list[str]:
    """Put back host and fam rows that are in the plan but were deleted from the tables.

    Rows come back exactly as they were when the plan was made, in their
    original positions, so the plan matches the tables again.
    """
    if state.plan is None:
        return []
    restored: list[str] = []
    snap = state.plan_tables or {"hosts": [], "fams": []}

    def merge(current: list[dict], saved: list[dict], plan_ids: list[str], id_col: str, rebuild) -> list[dict]:
        now = {r.get(id_col): r for r in current}
        saved_by_id = {r.get(id_col): r for r in saved}
        order = [r.get(id_col) for r in saved] or plan_ids
        out = []
        for ident in order:
            if ident in now:
                out.append(now.pop(ident))
            elif ident in plan_ids:
                row = copy.deepcopy(saved_by_id[ident]) if ident in saved_by_id else rebuild(ident)
                out.append(row)
                restored.append(row.get("table_label") or row.get("fam_label") or ident)
        return out + [r for r in current if r.get(id_col) in now]

    hosts = {h.host_id: h for h in state.plan.hosts}
    fams = {f.group_id: f for f in state.plan.fams}
    state.hosts = merge(
        state.hosts, snap["hosts"], list(hosts), "host_id",
        lambda i: {"host_id": i, "table_label": hosts[i].name, "host_name": hosts[i].person, "tags": "; ".join(sorted(hosts[i].tags))},
    )
    state.fams = merge(
        state.fams, snap["fams"], list(fams), "fam_id",
        lambda i: {"fam_id": i, "table_number": str(fams[i].table_number or ""), "fam_label": fams[i].name,
                   "size": str(fams[i].size or ""), "interests": "; ".join(sorted(fams[i].interests)),
                   "students": "; ".join(fams[i].members)},
    )
    return restored


def removed_rows(state: EventState) -> list[str]:
    """Names in the plan whose rows are no longer in the tables, matched by id."""
    if state.plan is None:
        return []
    host_ids = {r.get("host_id") for r in clean_rows(state.hosts)}
    fam_ids = {r.get("fam_id") for r in clean_rows(state.fams)}
    return [h.name for h in state.plan.hosts if h.host_id not in host_ids] + [
        f.name for f in state.plan.fams if f.group_id not in fam_ids
    ]


# ----------------------------------------------------------------------
# Near-miss tags.
# ----------------------------------------------------------------------


def tag_key(tag: str) -> str:
    """Case, spaces, hyphens, and a trailing plural "s" do not count."""
    key = re.sub(r"[^a-z0-9]", "", tag.lower())
    if len(key) > 3 and key.endswith("s") and not key.endswith("ss"):
        key = key[:-1]
    return key


@dataclass(frozen=True)
class NearMiss:
    spellings: tuple[str, ...]
    suggestion: str


def near_misses(host_rows: Iterable[dict], fam_rows: Iterable[dict]) -> list[NearMiss]:
    """Groups of spellings that look the same to a person but not to the scorer.

    Only groups used on both sides matter, since a tag scores only when a
    host and a fam share it. The suggestion is the most used spelling.
    """
    from collections import Counter

    from .sheets import split_tags

    host_count, fam_count = Counter(), Counter()
    for r in clean_rows(host_rows):
        host_count.update(set(split_tags(r.get("tags", ""))))
    for r in clean_rows(fam_rows):
        fam_count.update(set(split_tags(r.get("interests", ""))))
    groups: dict[str, set[str]] = {}
    for t in set(host_count) | set(fam_count):
        groups.setdefault(tag_key(t), set()).add(t)
    # A short single word that starts a longer one, such as math and
    # mathematics or econ and economics, is probably the same thing.
    for short in sorted(groups, key=len):
        if len(short) < 4 or short not in groups or any(" " in t for t in groups[short]):
            continue
        longer = [k for k in groups if k != short and k.startswith(short) and not any(" " in t for t in groups[k])]
        if len(longer) == 1:
            groups[longer[0]] |= groups.pop(short)
    out = []
    for key, spellings in sorted(groups.items()):
        if len(spellings) < 2:
            continue
        on_hosts = spellings & set(host_count)
        on_fams = spellings & set(fam_count)
        if not on_hosts or not on_fams:
            continue
        total = host_count + fam_count
        best = sorted(spellings, key=lambda s: (-total[s], s.endswith("s") and s[:-1] in spellings, -len(s), s))[0]
        out.append(NearMiss(tuple(sorted(spellings)), best))
    return out


def apply_spelling(state: EventState, miss: NearMiss) -> None:
    """Rewrite every spelling in the group to the suggestion, in both tables."""
    from .sheets import split_tags

    def fix(text: str) -> str:
        tags = [miss.suggestion if t in miss.spellings else t for t in split_tags(text)]
        return "; ".join(dict.fromkeys(tags))

    for r in state.hosts:
        r["tags"] = fix(r.get("tags", ""))
    for r in state.fams:
        r["interests"] = fix(r.get("interests", ""))


# ----------------------------------------------------------------------
# Saving and loading.
# ----------------------------------------------------------------------


def _plan_to_dict(plan: EventPlan | None) -> dict | None:
    if plan is None:
        return None
    return {
        "hosts": [{"id": h.host_id, "name": h.name, "theme": h.theme, "tags": sorted(h.tags), "person": h.person} for h in plan.hosts],
        "fams": [
            {"id": f.group_id, "name": f.name, "interests": sorted(f.interests), "size": f.size,
             "table_number": f.table_number, "members": list(f.members)}
            for f in plan.fams
        ],
        "rounds": plan.rounds,
        "assignments": [[a.round_number, a.host_id, a.group_id, a.score] for a in plan.assignments],
        "free_rounds": plan.free_rounds,
        "host_breaks": plan.host_breaks,
        "total_score": plan.total_score,
        "objective_bound": plan.objective_bound,
        "objective_value": plan.objective_value,
        "kept_slots": plan.kept_slots,
        "runtime_s": plan.runtime_s,
        "warnings": plan.warnings,
        "rules": [[r.kind, r.host_id, r.fam_id, list(r.rounds)] for r in plan.rules],
        "host_away": plan.host_away,
        "host_limits": plan.host_limits,
        "fam_away": plan.fam_away,
        "locked_rounds": plan.locked_rounds,
    }


def _plan_from_dict(d: dict | None) -> EventPlan | None:
    if d is None:
        return None
    return EventPlan(
        hosts=[Host.make(h["id"], h["name"], h["theme"], h["tags"], person=h.get("person", "")) for h in d["hosts"]],
        fams=[
            GuestGroup.make(f["id"], f["name"], f["interests"], size=f["size"], table_number=f["table_number"],
                            members=f.get("members", []))
            for f in d["fams"]
        ],
        rounds=d["rounds"],
        assignments=[Assignment(r, h, g, s) for r, h, g, s in d["assignments"]],
        free_rounds=d["free_rounds"],
        host_breaks=d["host_breaks"],
        total_score=d["total_score"],
        objective_bound=d["objective_bound"],
        runtime_s=d["runtime_s"],
        warnings=d["warnings"],
        rules=[Rule(k, h, f, tuple(rs)) for k, h, f, rs in d["rules"]],
        host_away=d["host_away"],
        host_limits=d.get("host_limits", {}),
        fam_away=d["fam_away"],
        locked_rounds=d["locked_rounds"],
        objective_value=d["objective_value"],
        kept_slots=d["kept_slots"],
    )


def save_event(state: EventState) -> str:
    """The whole event as JSON text, ready to download."""
    return json.dumps(
        {
            "format": FILE_FORMAT,
            "version": FILE_VERSION,
            "title": state.title,
            "rounds": state.rounds,
            "hosts": state.hosts,
            "fams": state.fams,
            "rules": state.rules,
            "finished": state.finished,
            "cancel_hosts": state.cancel_hosts,
            "cancel_fams": state.cancel_fams,
            "plan": _plan_to_dict(state.plan),
            "plan_inputs": state.plan_inputs,
            "printed": _plan_to_dict(state.printed),
            "one_weak_round": state.one_weak_round,
            "plan_tables": state.plan_tables,
            "start_time": state.start_time,
            "round_minutes": state.round_minutes,
            "printed_at": state.printed_at,
            "arrived": state.arrived,
            "notes": state.notes,
            "night_log": state.night_log,
        },
        indent=2,
    )


def load_event(text: str | bytes) -> EventState:
    """Read a file written by save_event(). Raises SheetError in plain words if it is not one."""
    try:
        d = json.loads(text)
    except (ValueError, TypeError):
        raise SheetError(["That file is not a saved event. Choose a file saved with Save event file."]) from None
    if not isinstance(d, dict) or d.get("format") != FILE_FORMAT:
        raise SheetError(["That file is not a saved event. Choose a file saved with Save event file."])
    if d.get("version") != FILE_VERSION:
        raise SheetError([f"That event was saved by a different version of this tool (file version {d.get('version')})."])
    try:
        return EventState(
            title=d["title"],
            rounds=int(d["rounds"]),
            hosts=d["hosts"],
            fams=d["fams"],
            rules=d["rules"],
            finished=int(d["finished"]),
            cancel_hosts={k: int(v) for k, v in d["cancel_hosts"].items()},
            cancel_fams={k: int(v) for k, v in d["cancel_fams"].items()},
            plan=_plan_from_dict(d["plan"]),
            plan_inputs=d["plan_inputs"],
            printed=_plan_from_dict(d["printed"]),
            one_weak_round=bool(d.get("one_weak_round", False)),
            plan_tables=d.get("plan_tables"),
            start_time=str(d.get("start_time", "")),
            round_minutes=int(d.get("round_minutes", 20)),
            printed_at=str(d.get("printed_at", "")),
            arrived=[str(x) for x in d.get("arrived", [])],
            notes=str(d.get("notes", "")),
            night_log=[{"at": str(e.get("at", "")), "text": str(e.get("text", ""))} for e in d.get("night_log", [])],
        )
    except (KeyError, TypeError, ValueError):
        raise SheetError(["That saved event is incomplete or damaged, so it cannot be loaded."]) from None


def handoff_event(state: EventState) -> EventState:
    """A copy for next year's coordinator: same tables and rules, no students and no night.

    Keeps the event name, rounds, host tables (names, alums, tags), fam
    names, sizes, and interests, rules, settings, and the notes for next
    year. Clears student names, cancellations, finished rounds, check-in,
    the night's log, and every schedule.
    """
    fams = [{**r, "students": ""} for r in state.fams]
    return EventState(
        title=state.title,
        rounds=state.rounds,
        hosts=[dict(r) for r in state.hosts],
        fams=fams,
        rules=[dict(r) for r in state.rules],
        one_weak_round=state.one_weak_round,
        start_time=state.start_time,
        round_minutes=state.round_minutes,
        notes=state.notes,
    )


def is_printed(state: EventState) -> bool:
    """True when the current schedule is the one marked as printed, including after a save and reopen."""
    return (state.printed is not None and state.plan is not None and state.printed.rounds == state.plan.rounds
            and state.printed.slots() == state.plan.slots())


@dataclass
class CheckItem:
    """One line of the Before the night checklist."""

    status: str  # "done", "todo", or "optional"
    text: str


def before_the_night(state: EventState, saved: bool) -> list[CheckItem]:
    """The checklist a coordinator runs before the event, worked out from the event itself.

    saved says whether the event file was saved since the last change; the
    app knows that, the event does not.
    """
    inputs = check_inputs(state)
    items: list[CheckItem] = []

    def add(ok: bool, done: str, todo: str, optional: bool = False) -> None:
        items.append(CheckItem("done" if ok else ("optional" if optional else "todo"), done if ok else todo))

    hosts, fams = inputs.hosts, inputs.fams
    add(not inputs.problems, "The tables and rules have no problems.",
        f"Fix the {len(inputs.problems)} problem{'s' if len(inputs.problems) != 1 else ''} listed under Please fix these first.")
    no_tags = [h.name for h in hosts if not h.tags]
    add(bool(hosts) and not no_tags, f"All {len(hosts)} host tables have tags.",
        f"Add tags for {len(no_tags)} host table{'s' if len(no_tags) != 1 else ''}: {', '.join(no_tags[:5])}{'…' if len(no_tags) > 5 else ''}.")
    no_interests = [f.name for f in fams if not f.interests]
    add(bool(fams) and not no_interests, f"All {len(fams)} fams have interests.",
        f"Add interests for {len(no_interests)} fam{'s' if len(no_interests) != 1 else ''}: {', '.join(no_interests[:5])}{'…' if len(no_interests) > 5 else ''}.")
    add(is_current(state), "The schedule is up to date.",
        "Find the best schedule (or re-plan): the schedule is missing or out of date.")
    if state.plan is not None and is_current(state):
        unfair = [w for w in state.plan.warnings if w.startswith("Fairness check")]
        add(not unfair, "Every fam gets a fair share of matching hosts, and every host table gets a fam.",
            f"Look at the {len(unfair)} fairness check{'s' if len(unfair) != 1 else ''} under the schedule.", optional=True)
    add(bool(hosts) and all(h.person for h in hosts), "Every host table has an alum's name for the host cards.",
        "Add alum names so host cards say who hosts each table.", optional=True)
    add(bool(fams) and all(f.members for f in fams), "Every fam has student names for the find-your-table page.",
        "Add student names to print a find-your-table page.", optional=True)
    add(is_printed(state), "The printed version is marked.",
        "Print the four documents, then click Mark as printed.")
    add(saved, "The event file is saved with every change.",
        "Click Save event file in the sidebar and keep the file for the night.")
    return items
