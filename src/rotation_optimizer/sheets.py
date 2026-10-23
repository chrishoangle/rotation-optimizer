"""Read hosts, fams, rules, and schedules from the tables a coordinator fills in.

The templates in templates/ show the expected columns. A spreadsheet tool
such as Google Sheets or Excel can export each sheet as CSV, and the app
passes its edited tables in as lists of row dicts.

hosts columns:
    table_label   required, for example "Pharmacy"
    tags          keywords separated by semicolons; blank is allowed while
                  a host has not replied, and scores 0 with every fam
    host_name     optional, who hosts the table; printed on host cards only
    host_id       optional, generated when blank

fams columns:
    fam_label     required, for example "Bio & Chem"
    interests     keywords separated by semicolons; blank is allowed and
                  scores 0 with every host
    size          optional, number of guests at the table
    table_number  optional, the physical table in the room; blank rows get
                  the next number not already used, counting from 1
    students      optional, guest names separated by semicolons; printed on
                  the find-your-table page only
    fam_id        optional, generated when blank

Rows that are blank in every cell are ignored. Empty spreadsheet cells
(None or NaN) count as blank. Problems are collected and reported together,
named the way a coordinator knows them: "Pharmacy", or "Row 3 of the
host tables" for a row with no name yet.
"""

from __future__ import annotations

import csv
import io
import math
import re
from pathlib import Path
from typing import Iterable, TextIO

from .models import GuestGroup, Host


class SheetError(ValueError):
    """Raised when a sheet cannot be read. The message lists every problem found."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


def cell(value) -> str:
    """One spreadsheet cell as clean text. None, NaN, and blanks become ""."""
    if value is None:
        return ""
    if isinstance(value, float):
        if math.isnan(value):
            return ""
        if value.is_integer():
            return str(int(value))
    return str(value).strip()


def clean_rows(rows: Iterable[dict]) -> list[dict[str, str]]:
    """Normalize headers and cells, and drop rows that are blank in every cell.

    The friendly template headers ("Host table name") become our column
    names ("table_label").
    """
    out = []
    for raw in rows:
        row = {_FRIENDLY_KEYS.get(_key(k), str(k).strip().lower()): cell(v) for k, v in raw.items() if isinstance(k, str)}
        if any(row.values()):
            out.append(row)
    return out


def _open(source: str | Path | TextIO) -> TextIO:
    if hasattr(source, "read"):
        text = source.read()
        if isinstance(text, bytes):
            text = text.decode("utf-8-sig")
        return io.StringIO(text)
    return io.StringIO(Path(source).read_text(encoding="utf-8-sig"))


def _csv_rows(source, sheet: str, required: Iterable[str]) -> list[dict[str, str]]:
    reader = csv.DictReader(_open(source))
    raw = list(reader)
    fieldnames = [h for h in (reader.fieldnames or []) if h]
    if sheet in FILE_COLUMNS:
        # Accept the friendly template headers ("Host table name") as well as ours.
        mapping = match_columns(fieldnames, sheet)
        back = {theirs: ours for ours, theirs in mapping.items()}
        raw = [{back.get(k, k): v for k, v in r.items()} for r in raw]
        fieldnames = [back.get(h, h) for h in fieldnames]
        raw, _ = drop_example_rows(raw)
    headers = [h.strip().lower() for h in fieldnames]
    missing = [c for c in required if c not in headers]
    if missing:
        names = [FRIENDLY.get(c, c) for c in missing]
        raise SheetError([f"{sheet}: missing column(s) {', '.join(names)}. Found: {', '.join(fieldnames) or 'none'}."])
    rows = clean_rows(raw)
    if not rows:
        raise SheetError([f"{sheet}: no rows found."])
    return rows


def split_tags(text: str) -> list[str]:
    return [t.strip().lower() for t in text.replace(",", ";").split(";") if t.strip()]


def _who(kind: str, i: int, label: str) -> str:
    """How a message names a row: its name, or its place when it has no name yet."""
    if label:
        return label
    return f"The {'host table' if kind == 'host' else 'fam'} in row {i}"


def hosts_from_rows(rows: Iterable[dict]) -> tuple[list[Host], list[str], list[str]]:
    """Build hosts from table rows. Returns (hosts, problems, warnings); problems block planning."""
    problems: list[str] = []
    warnings: list[str] = []
    hosts: list[Host] = []
    rows = clean_rows(rows)
    used_ids = {r.get("host_id", "") for r in rows if r.get("host_id")}
    seen_ids: set[str] = set()
    labels: dict[str, int] = {}
    blank: list[str] = []
    next_id = 1
    for i, row in enumerate(rows, start=1):
        label = row.get("table_label", "")
        who = _who("host", i, label)
        host_id = row.get("host_id", "")
        if not host_id:
            while f"h{next_id:02d}" in used_ids:
                next_id += 1
            host_id = f"h{next_id:02d}"
            used_ids.add(host_id)
        tags = split_tags(row.get("tags", ""))
        if not label:
            problems.append(f"Row {i} of the host tables has no table name. Add one, or delete the row.")
        elif label.lower() in labels:
            problems.append(f"Two host tables are named {label}. Each table needs its own name.")
        else:
            labels[label.lower()] = i
        if host_id in seen_ids:
            problems.append(f"{who} has the same row ID ({host_id}) as an earlier row. Delete the copy, or clear the ID in one of them.")
        seen_ids.add(host_id)
        if not tags:
            blank.append(who)
        hosts.append(Host.make(host_id, label, label, tags, person=row.get("host_name", "")))
    if not hosts:
        problems.append("Add at least one host table.")
    if blank and len(blank) == len(hosts) and len(hosts) > 1:
        warnings.append("No host table has tags yet, so every pairing scores 0. Add tags to match hosts to fams. You can still plan.")
    else:
        warnings += [f"{who} has no tags yet, so it scores 0 with every fam. You can still plan." for who in blank]
    return hosts, problems, warnings


def fams_from_rows(rows: Iterable[dict]) -> tuple[list[GuestGroup], list[str], list[str]]:
    """Build fams from table rows. Returns (fams, problems, warnings); problems block planning."""
    problems: list[str] = []
    warnings: list[str] = []
    built: list[tuple[str, str, list[str], int, int | None, list[str]]] = []
    rows = clean_rows(rows)
    used_ids = {r.get("fam_id", "") for r in rows if r.get("fam_id")}
    seen_ids: set[str] = set()
    labels: dict[str, int] = {}
    numbers: dict[int, str] = {}
    blank: list[str] = []
    next_id = 1
    for i, row in enumerate(rows, start=1):
        label = row.get("fam_label", "")
        who = _who("fam", i, label)
        fam_id = row.get("fam_id", "")
        if not fam_id:
            while f"fam_{next_id:02d}" in used_ids:
                next_id += 1
            fam_id = f"fam_{next_id:02d}"
            used_ids.add(fam_id)
        interests = split_tags(row.get("interests", ""))
        size = 0
        if row.get("size"):
            try:
                size = int(row["size"])
            except ValueError:
                problems.append(f"{who}: the size {row['size']!r} is not a whole number.")
        number = None
        if row.get("table_number"):
            try:
                number = int(row["table_number"])
                if number < 1:
                    raise ValueError
            except ValueError:
                problems.append(f"{who}: the table number {row['table_number']!r} is not a whole number from 1 up.")
                number = None
        if number is not None:
            if number in numbers:
                problems.append(f"{numbers[number]} and {who} both use table number {number}. Each fam needs its own table number.")
            else:
                numbers[number] = who
        if not label:
            problems.append(f"Row {i} of the fams has no fam name. Add one, or delete the row.")
        elif label.lower() in labels:
            problems.append(f"Two fams are named {label}. Each fam needs its own name.")
        else:
            labels[label.lower()] = i
        if fam_id in seen_ids:
            problems.append(f"{who} has the same row ID ({fam_id}) as an earlier row. Delete the copy, or clear the ID in one of them.")
        seen_ids.add(fam_id)
        if not interests:
            blank.append(who)
        built.append((fam_id, label, interests, size, number, split_tags_keep_case(row.get("students", ""))))
    if not built:
        problems.append("Add at least one fam.")
    if blank and len(blank) == len(built) and len(built) > 1:
        warnings.append("No fam has interests yet, so every pairing scores 0. Add interests to match fams to hosts. You can still plan.")
    else:
        warnings += [f"{who} has no interests yet, so it scores 0 with every host. You can still plan." for who in blank]
    fams: list[GuestGroup] = []
    next_number = 1
    for fam_id, label, interests, size, number, members in built:
        if number is None:
            while next_number in numbers:
                next_number += 1
            number = next_number
            numbers[number] = label
        fams.append(GuestGroup.make(fam_id, label, interests, size=size, table_number=number, members=members))
    return fams, problems, warnings


def split_tags_keep_case(text: str) -> list[str]:
    return [t.strip() for t in text.replace(",", ";").split(";") if t.strip()]


def load_hosts(source: str | Path | TextIO) -> list[Host]:
    """Read host tables from a CSV path or file-like object. Raises SheetError on problems."""
    hosts, problems, _ = hosts_from_rows(_csv_rows(source, "hosts", ["table_label", "tags"]))
    if problems:
        raise SheetError(problems)
    return hosts


def load_fams(source: str | Path | TextIO) -> list[GuestGroup]:
    """Read fams from a CSV path or file-like object. Raises SheetError on problems."""
    fams, problems, _ = fams_from_rows(_csv_rows(source, "fams", ["fam_label", "interests"]))
    if problems:
        raise SheetError(problems)
    return fams


def host_id_by_label(hosts: list[Host], label: str) -> str:
    """Look up a host id from its table label, ignoring case. Raises SheetError if unknown."""
    for h in hosts:
        if h.name.lower() == label.strip().lower():
            return h.host_id
    raise SheetError([f"No host table named {label!r}."])


def fam_id_by_label(fams: list[GuestGroup], label: str) -> str:
    """Look up a fam id from its label, ignoring case. Raises SheetError if unknown."""
    for f in fams:
        if f.name.lower() == label.strip().lower():
            return f.group_id
    raise SheetError([f"No fam named {label!r}."])


def load_schedule(
    source: str | Path | TextIO, hosts: list[Host], fams: list[GuestGroup]
) -> list[tuple[int, str, str]]:
    """Read a schedule CSV written by schedule_csv() back into (round, host_id, fam_id) slots.

    Rows with an open table or a fam that is not attending have no host and
    are skipped.
    """
    rows = _csv_rows(source, "schedule", ["round", "fam", "host_table"])
    problems: list[str] = []
    slots: list[tuple[int, str, str]] = []
    for i, row in enumerate(rows, start=2):
        if row["host_table"].lower().startswith(("open table", "not attending")):
            continue
        try:
            r = int(row["round"])
        except ValueError:
            problems.append(f"schedule row {i}: round {row['round']!r} is not a whole number.")
            continue
        try:
            slots.append((r, host_id_by_label(hosts, row["host_table"]), fam_id_by_label(fams, row["fam"])))
        except SheetError as err:  # SheetError is a ValueError, so it is caught separately
            problems.append(f"schedule row {i}: {err.problems[0]}")
    if problems:
        raise SheetError(problems)
    return slots


RULE_KINDS = {
    "must meet": "must", "never meet": "never", "only in rounds": "only", "stays with": "stays",
    "needs step-free": "access",
}


def parse_rounds(text: str, rounds: int) -> tuple[int, ...]:
    """Read "1", "1,2", "1;2", "1 2", or "1 and 2" as round numbers. Blank means none.

    Raises ValueError with a plain message for anything else.
    """
    text = cell(text)
    if not text:
        return ()
    parts = [p for p in re.split(r"[,;\s]+|\band\b", text) if p and p.strip()]
    out = []
    for part in parts:
        try:
            value = float(part)
        except ValueError:
            raise ValueError(f"{text!r} is not a list of round numbers like 1, 2") from None
        if not value.is_integer():
            raise ValueError(f"{text!r} is not a list of round numbers like 1, 2")
        n = int(value)
        if not 1 <= n <= rounds:
            raise ValueError(f"there is no round {n}, the event has {rounds} round{'s' if rounds != 1 else ''}")
        out.append(n)
    return tuple(sorted(set(out)))


def parse_rule_rows(rows: Iterable[dict], hosts: list[Host], fams: list[GuestGroup], rounds: int):
    """Turn the rules table into Rule objects and host availability.

    Each row has rule ("must meet", "never meet", "only in rounds", or
    "stays with"), host_table, fam, and rounds. Blank rounds means any round.
    "only in rounds" needs no fam: the host is away in every other round.
    "stays with" keeps the host at one fam all night; a blank fam lets the
    planner choose, and rounds must be blank. Returns
    (rules, host_away). Blank rows are ignored. Raises SheetError listing
    every problem.
    """
    from .planning import Rule  # local import: planning imports nothing from sheets

    problems: list[str] = []
    rules: list = []
    host_away: dict[str, list[int]] = {}
    for i, row in enumerate(clean_rows(rows), start=1):
        kind = RULE_KINDS.get(row.get("rule", "").lower())
        if kind is None:
            problems.append(f"Pairing rule {i}: choose must meet, never meet, only in rounds, stays with, or needs step-free.")
            continue
        try:
            h = host_id_by_label(hosts, row.get("host_table", ""))
        except SheetError:
            problems.append(f"Pairing rule {i}: choose a host table from the list.")
            continue
        try:
            rs = parse_rounds(row.get("rounds", ""), rounds)
        except ValueError as err:
            problems.append(f"Pairing rule {i}: {err}.")
            continue
        if kind == "only":
            if not rs:
                problems.append(f"Pairing rule {i}: only in rounds needs at least one round.")
                continue
            host_away[h] = sorted(set(range(1, rounds + 1)) - set(rs))
            continue
        if kind == "access":
            if rs or row.get("fam", "").strip():
                problems.append(f"Pairing rule {i}: needs step-free applies to every table, so leave Fam and Rounds blank.")
                continue
            rules.append(Rule("access", h, "", ()))
            continue
        if kind == "stays":
            if rs:
                problems.append(f"Pairing rule {i}: stays with is for the whole night, so leave Rounds blank.")
                continue
            if not row.get("fam", "").strip():
                rules.append(Rule("stays", h, "", ()))
                continue
        try:
            f = fam_id_by_label(fams, row.get("fam", ""))
        except SheetError:
            problems.append(f"Pairing rule {i}: choose a fam from the list.")
            continue
        rules.append(Rule(kind, h, f, rs))
    if problems:
        raise SheetError(problems)
    return rules, {h: rs for h, rs in host_away.items() if rs}


def removed_after_lock(plan, host_labels: list[str], fam_labels: list[str]) -> list[str]:
    """Names from the plan that are missing from the edited tables.

    Once a round is finished, removing a row would rewrite what already
    happened, so the app blocks it and offers to restore the rows.
    """
    hosts = {s.strip().lower() for s in host_labels}
    fams = {s.strip().lower() for s in fam_labels}
    gone = [h.name for h in plan.hosts if h.name.lower() not in hosts]
    gone += [f.name for f in plan.fams if f.name.lower() not in fams]
    return gone


# ----------------------------------------------------------------------
# Reading an uploaded file: match its columns to ours.
# ----------------------------------------------------------------------

# What a coordinator sees for each column, in templates and messages.
FRIENDLY = {
    "table_label": "Host table name",
    "host_name": "Alum's name",
    "tags": "Tags",
    "table_number": "Table number",
    "fam_label": "Fam name",
    "size": "Size",
    "interests": "Interests",
    "students": "Students",
    "location": "Location in the room",
    "step_free": "Step-free access",
}
FILE_COLUMNS = {
    "hosts": ["table_label", "host_name", "tags"],
    "fams": ["table_number", "fam_label", "size", "interests", "students", "location", "step_free"],
}
REQUIRED = {"hosts": ["table_label"], "fams": ["fam_label"]}
EXAMPLE_MARK = "(example)"

# Other names a column goes by, compared without case, spaces, or punctuation.
_SYNONYMS = {
    "table_label": ["table", "table name", "host table", "career", "field", "theme", "topic"],
    "host_name": ["name", "alum", "alum name", "alumni", "alumnus", "host", "host name", "full name", "your name"],
    "tags": ["tag", "keywords", "topics", "interests", "areas", "expertise"],
    "fam_label": ["fam", "group", "group name", "family", "family name"],
    "interests": ["interest", "majors", "major", "keywords", "tags", "topics"],
    "table_number": ["table", "table no", "table #", "number"],
    "students": ["student", "student name", "names", "members", "admits", "student names", "name", "your name", "full name"],
    "size": ["count", "students count", "number of students", "how many"],
    "location": ["location", "where", "where in the room", "zone", "spot", "room location"],
    "step_free": ["step free", "stepfree", "accessible", "wheelchair accessible", "access", "accessibility"],
}

# Words inside a longer header, such as a Google Forms question
# ("What is your name?"). Checked in this order; each file column is used once.
_HINTS = {
    "hosts": [
        ("table_label", ["table name", "host table", "career", "industry", "field", "table"], []),
        ("host_name", ["name"], ["table", "fam", "group"]),
        ("tags", ["tag", "keyword", "topic", "interest", "expertise", "area", "talk about", "subject"], []),
    ],
    "fams": [
        ("table_number", ["table number", "table #", "table no", "table"], ["name"]),
        ("fam_label", ["fam", "family", "group"], ["number", "size", "how many"]),
        ("size", ["size", "how many"], []),
        ("interests", ["interest", "major", "tag", "keyword", "topic"], []),
        ("students", ["student", "name", "admit"], []),
    ],
}

# Columns a form adds that the tool never uses. They are dropped on import,
# so emails and phone numbers never reach the event file.
_NEVER = ["timestamp", "email", "e mail", "phone", "score"]


def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9#]+", "", str(text).lower())


_FRIENDLY_KEYS = {_key(v): k for k, v in FRIENDLY.items()}


def _words(text: str) -> str:
    return " " + re.sub(r"[^a-z0-9#]+", " ", str(text).lower()).strip() + " "


def match_columns(columns: Iterable[str], kind: str) -> dict[str, str]:
    """Guess which column in a file holds each of ours. Returns {our column: file column}."""
    found = [c for c in columns if c and str(c).strip() and not any(w in _words(c) for w in (" " + n + " " for n in _NEVER))]
    mapping: dict[str, str] = {}
    used: set[str] = set()

    def take(ours: str, theirs: str) -> None:
        mapping[ours] = theirs
        used.add(theirs)

    ours_all = FILE_COLUMNS[kind]
    # 1. Our own column names, or the friendly ones from the templates.
    for ours in ours_all:
        for c in found:
            if c not in used and _key(c) in (_key(ours), _key(FRIENDLY[ours])):
                take(ours, c)
                break
    # 2. Other common names for the whole header.
    for ours in ours_all:
        if ours in mapping:
            continue
        names = {_key(n) for n in _SYNONYMS.get(ours, [])}
        for c in found:
            if c not in used and _key(c) in names:
                take(ours, c)
                break
    # 3. Words inside a longer header.
    for ours, include, exclude in _HINTS[kind]:
        if ours in mapping:
            continue
        for c in found:
            w = _words(c)
            if c in used or any(_words(x).strip() in w for x in exclude):
                continue
            if any(" " + _words(x).strip() + " " in w or (len(x) > 4 and x in w) for x in include):
                take(ours, c)
                break
    return mapping


def column_report(columns: Iterable[str], kind: str, mapping: dict[str, str] | None = None
                  ) -> tuple[list[str], list[str], dict[str, str]]:
    """Check an uploaded file's columns before it replaces a table.

    Returns (problems, notices, mapping). mapping is {our column: file
    column}; when not given it is guessed with match_columns. Problems name
    each required column that has no match, once. Notices name each
    optional column that has no match, once.
    """
    found = [c for c in columns if c and str(c).strip()]
    if mapping is None:
        mapping = match_columns(found, kind)
    mapping = {k: v for k, v in mapping.items() if v}
    listing = ", ".join(found) or "none"
    problems, notices = [], []
    for col in REQUIRED[kind]:
        if col not in mapping:
            problems.append(f"Choose the column in your file that holds the {FRIENDLY[col].lower()}. Columns found: {listing}.")
    what = {
        "tags": "every host will score 0 until you add tags",
        "interests": "every fam will score 0 until you add interests",
        "host_name": "host cards will show only the table name",
        "students": "the find-your-table page will be empty",
        "table_number": "tables will be numbered 1, 2, 3 in file order",
        "size": "fam sizes will be counted from the students, or left blank",
    }
    for col in FILE_COLUMNS[kind]:
        if col not in mapping and col not in REQUIRED[kind] and col in what:  # location and step-free are rarely in a file
            notices.append(f"No {FRIENDLY[col].lower()} column, so {what[col]}.")
    return problems, notices, mapping


def rename_columns(rows: list[dict], mapping: dict[str, str]) -> list[dict]:
    """Keep only the matched columns, renamed to ours. mapping is {our column: file column}.

    Columns that are not matched are dropped, so a form's email or phone
    column is never stored.
    """
    return [{ours: r.get(theirs, "") for ours, theirs in mapping.items() if theirs} for r in rows]


def drop_example_rows(rows: list[dict]) -> tuple[list[dict], int]:
    """Remove the template's example rows, the ones whose first cell starts with (example)."""
    kept = [r for r in rows if not any(cell(v).lower().startswith(EXAMPLE_MARK) for v in r.values())]
    return kept, len(rows) - len(kept)


def group_student_rows(rows: list[dict]) -> tuple[list[dict], int]:
    """Turn one row per student into one row per fam, when fam names repeat.

    A file counts as one row per student when at least half the rows have a
    single student name. Otherwise repeated fam names are left alone, so they
    are reported as duplicates instead of merged.

    Rows with the same fam name become one fam: the students are joined,
    the interests are combined without repeats, and the size is the number
    of students when no size is given. Returns (rows, students grouped);
    rows come back unchanged, with 0, when no fam name repeats.
    """
    names = [cell(r.get("fam_label", "")).lower() for r in rows if cell(r.get("fam_label", ""))]
    students = [cell(r.get("students", "")) for r in rows]
    one_each = sum(1 for x in students if x) >= len(rows) / 2 and not any(";" in x for x in students)
    if len(names) == len(set(names)) or not one_each:
        # Not one row per student: leave repeated fam names for the duplicate check.
        return rows, 0
    fams: dict[str, dict] = {}
    count = 0
    for r in rows:
        label = cell(r.get("fam_label", ""))
        if not label:
            continue
        fam = fams.setdefault(label.lower(), {"fam_label": label, "table_number": "", "size": "", "interests": [], "students": []})
        if not fam["table_number"] and cell(r.get("table_number", "")):
            fam["table_number"] = cell(r.get("table_number", ""))
        for t in split_tags_keep_case(cell(r.get("interests", ""))):
            if t.lower() not in [x.lower() for x in fam["interests"]]:
                fam["interests"].append(t)
        student = cell(r.get("students", ""))
        if student:
            fam["students"].append(student)
            count += 1
    out = []
    for fam in fams.values():
        out.append({
            "table_number": fam["table_number"],
            "fam_label": fam["fam_label"],
            "size": str(len(fam["students"])) if fam["students"] else "",
            "interests": "; ".join(fam["interests"]),
            "students": "; ".join(fam["students"]),
        })
    return out, count


def template_csv(kind: str) -> str:
    """A template with friendly headers and one example row, which uploading skips."""
    example = {
        "hosts": ["(example) Physician (MD)", "Alum A", "medicine; healthcare; pre-med"],
        "fams": ["1", "(example) Bio & Chem", "6", "biology; chemistry; pre-med", "Student 01; Student 02", "by the stage", "yes"],
    }[kind]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([FRIENDLY[c] for c in FILE_COLUMNS[kind]])
    writer.writerow(example)
    return buf.getvalue()
