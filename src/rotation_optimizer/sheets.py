"""Read hosts and fams from CSV files a coordinator fills in.

The templates in templates/ show the expected columns. A spreadsheet tool
such as Google Sheets or Excel can export each sheet as CSV.

hosts.csv columns:
    table_label   required, for example "Pharmacy"
    tags          required, keywords separated by semicolons
    host_id       optional, generated from the row number when blank

fams.csv columns:
    fam_label     required, for example "Bio & Chem"
    interests     required, keywords separated by semicolons
    size          optional, number of guests at the table
    table_number  optional, the physical table in the room; blank rows get
                  the next number not already used, counting from 1
    fam_id        optional, generated from the row number when blank

Problems are collected and raised together as one SheetError, so a
coordinator can fix every row in one pass.
"""

from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Iterable, TextIO

from .models import GuestGroup, Host


class SheetError(ValueError):
    """Raised when a sheet cannot be read. The message lists every problem found."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


def _open(source: str | Path | TextIO) -> TextIO:
    if hasattr(source, "read"):
        text = source.read()
        if isinstance(text, bytes):
            text = text.decode("utf-8-sig")
        return io.StringIO(text)
    return io.StringIO(Path(source).read_text(encoding="utf-8-sig"))


def _rows(source, sheet: str, required: Iterable[str]) -> list[dict[str, str]]:
    reader = csv.DictReader(_open(source))
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    missing = [c for c in required if c not in headers]
    if missing:
        raise SheetError([f"{sheet}: missing column(s) {', '.join(missing)}. Found: {', '.join(headers) or 'none'}."])
    rows = []
    for raw in reader:
        # Extra cells beyond the header land under the key None; ignore them.
        row = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if isinstance(k, str)}
        if any(row.values()):
            rows.append(row)
    if not rows:
        raise SheetError([f"{sheet}: no rows found."])
    return rows


def _split(cell: str) -> list[str]:
    return [t.strip().lower() for t in cell.replace(",", ";").split(";") if t.strip()]


def load_hosts(source: str | Path | TextIO) -> list[Host]:
    """Read host tables from a CSV path or file-like object."""
    rows = _rows(source, "hosts", ["table_label", "tags"])
    problems: list[str] = []
    hosts: list[Host] = []
    seen: set[str] = set()
    labels: set[str] = set()
    for i, row in enumerate(rows, start=2):  # row 1 is the header
        label = row.get("table_label", "")
        host_id = row.get("host_id") or f"h{i - 1:02d}"
        tags = _split(row.get("tags", ""))
        if not label:
            problems.append(f"hosts row {i}: table_label is empty.")
        if not tags:
            problems.append(f"hosts row {i} ({label or host_id}): no tags, so this table would score 0 with every fam.")
        if host_id in seen:
            problems.append(f"hosts row {i}: host_id {host_id} is used more than once.")
        seen.add(host_id)
        if label and label.lower() in labels:
            problems.append(f"hosts row {i}: table_label {label} is used more than once. Labels must be unique.")
        labels.add(label.lower())
        hosts.append(Host.make(host_id, label, label, tags))
    if problems:
        raise SheetError(problems)
    return hosts


def load_fams(source: str | Path | TextIO) -> list[GuestGroup]:
    """Read fams (stationary guest groups) from a CSV path or file-like object."""
    rows = _rows(source, "fams", ["fam_label", "interests"])
    problems: list[str] = []
    fams: list[GuestGroup] = []
    seen: set[str] = set()
    labels: set[str] = set()
    for i, row in enumerate(rows, start=2):
        label = row.get("fam_label", "")
        fam_id = row.get("fam_id") or f"fam_{i - 1:02d}"
        interests = _split(row.get("interests", ""))
        size_cell = row.get("size", "")
        size = 0
        if size_cell:
            try:
                size = int(size_cell)
            except ValueError:
                problems.append(f"fams row {i} ({label or fam_id}): size {size_cell!r} is not a whole number.")
        if not label:
            problems.append(f"fams row {i}: fam_label is empty.")
        if not interests:
            problems.append(f"fams row {i} ({label or fam_id}): no interests, so this fam would score 0 with every host.")
        if fam_id in seen:
            problems.append(f"fams row {i}: fam_id {fam_id} is used more than once.")
        seen.add(fam_id)
        if label and label.lower() in labels:
            problems.append(f"fams row {i}: fam_label {label} is used more than once. Labels must be unique.")
        labels.add(label.lower())
        number = None
        cell = row.get("table_number", "")
        if cell:
            try:
                number = int(cell)
                if number < 1:
                    raise ValueError
            except ValueError:
                problems.append(f"fams row {i} ({label or fam_id}): table_number {cell!r} is not a whole number from 1 up.")
                number = None
        fams.append(GuestGroup.make(fam_id, label, interests, size=size, table_number=number))
    used: dict[int, str] = {}
    for f in fams:
        if f.table_number is not None:
            if f.table_number in used:
                problems.append(f"fams: table_number {f.table_number} is used by both {used[f.table_number]} and {f.name}.")
            used[f.table_number] = f.name
    if problems:
        raise SheetError(problems)
    next_number = 1
    numbered = []
    for f in fams:
        if f.table_number is None:
            while next_number in used:
                next_number += 1
            used[next_number] = f.name
            f = GuestGroup.make(f.group_id, f.name, f.interests, size=f.size, table_number=next_number)
        numbered.append(f)
    return numbered


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

    Rows with an open table have no host and are skipped, which is how
    replanning treats them: that fam stays without a host in that round.
    """
    rows = _rows(source, "schedule", ["round", "fam", "host_table"])
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


RULE_KINDS = {"must meet": "must", "never meet": "never", "only in rounds": "only"}


def _parse_rounds(cell: str, rounds: int) -> tuple[int, ...]:
    out = []
    for part in cell.replace(";", ",").replace(" and ", ",").split(","):
        part = part.strip()
        if not part:
            continue
        n = int(part)  # ValueError is reported by the caller
        if not 1 <= n <= rounds:
            raise ValueError(f"round {n} is outside 1 to {rounds}")
        out.append(n)
    return tuple(sorted(set(out)))


def parse_rule_rows(
    rows: list[dict[str, str]], hosts: list[Host], fams: list[GuestGroup], rounds: int
):
    """Turn the app's rules table into Rule objects and host availability.

    Each row has rule ("must meet", "never meet", or "only in rounds"),
    host_table, fam, and rounds ("1, 2"; blank means any round). "only in
    rounds" needs no fam: the host is away in every other round. Returns
    (rules, host_away). Rows with every cell blank are ignored.
    """
    from .planning import Rule  # local import: planning imports nothing from sheets

    problems: list[str] = []
    rules: list = []
    host_away: dict[str, list[int]] = {}
    for i, raw in enumerate(rows, start=1):
        row = {k: ("" if v is None else str(v)).strip() for k, v in raw.items()}
        if not any(row.values()):
            continue
        kind = RULE_KINDS.get(row.get("rule", "").lower())
        if kind is None:
            problems.append(f"Rule {i}: choose must meet, never meet, or only in rounds.")
            continue
        try:
            h = host_id_by_label(hosts, row.get("host_table", ""))
        except SheetError:
            problems.append(f"Rule {i}: choose a host table from the list.")
            continue
        try:
            rs = _parse_rounds(row.get("rounds", ""), rounds)
        except ValueError as err:
            msg = str(err) if "outside" in str(err) else f"{row.get('rounds')!r} is not a list of round numbers like 1, 2"
            problems.append(f"Rule {i}: {msg}.")
            continue
        if kind == "only":
            if not rs:
                problems.append(f"Rule {i}: only in rounds needs at least one round.")
                continue
            host_away[h] = sorted(set(range(1, rounds + 1)) - set(rs))
            continue
        try:
            f = fam_id_by_label(fams, row.get("fam", ""))
        except SheetError:
            problems.append(f"Rule {i}: choose a fam from the list.")
            continue
        rules.append(Rule(kind, h, f, rs))
    if problems:
        raise SheetError(problems)
    return rules, {h: rs for h, rs in host_away.items() if rs}


def removed_after_lock(plan, host_labels: list[str], fam_labels: list[str]) -> list[str]:
    """Names from the plan that are missing from the edited tables.

    Once a round is locked, removing a row would rewrite what already
    happened, so the app blocks it and points to the cancel action instead.
    """
    hosts = {s.strip().lower() for s in host_labels}
    fams = {s.strip().lower() for s in fam_labels}
    gone = [h.name for h in plan.hosts if h.name.lower() not in hosts]
    gone += [f.name for f in plan.fams if f.name.lower() not in fams]
    return gone
