"""Tests for the coordinator-facing tool: sheets, uneven events, exports, CLI."""

from __future__ import annotations

import importlib.util
import io
from collections import Counter
from pathlib import Path

import pytest

from rotation_optimizer import (
    GuestGroup,
    Host,
    InfeasibleProblemError,
    SheetError,
    load_fams,
    load_hosts,
    plan_event,
    schedule_csv,
    schedule_rows,
    seating_chart_html,
    solve,
    vocabulary_warnings,
)
from rotation_optimizer.cli import main as cli_main

ROOT = Path(__file__).resolve().parents[1]
HOSTS_CSV = ROOT / "templates" / "hosts.csv"
FAMS_CSV = ROOT / "templates" / "fams.csv"


def _example():
    spec = importlib.util.spec_from_file_location("stew_dinner", ROOT / "examples" / "stew_dinner.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _check_invariants(plan):
    """C1, C2, C3 on real hosts and fams, allowing open tables and breaks."""
    for r in range(1, plan.rounds + 1):
        rows = [a for a in plan.assignments if a.round_number == r]
        host_counts = Counter(a.host_id for a in rows)
        fam_counts = Counter(a.group_id for a in rows)
        assert max(host_counts.values()) == 1  # C1: no host at two tables
        assert max(fam_counts.values()) == 1  # C2: no fam with two hosts
        for h in plan.hosts:
            sat_out = r in plan.host_breaks.get(h.host_id, [])
            assert (host_counts[h.host_id] == 1) != sat_out
        for f in plan.fams:
            free = r in plan.free_rounds.get(f.group_id, [])
            assert (fam_counts[f.group_id] == 1) != free
    pairs = Counter((a.host_id, a.group_id) for a in plan.assignments)
    assert max(pairs.values()) == 1  # C3


# ----------------------------------------------------------------------
# Templates reproduce the committed example.
# ----------------------------------------------------------------------


def test_templates_match_example_score():
    ex = _example()
    plan = plan_event(load_hosts(HOSTS_CSV), load_fams(FAMS_CSV), rounds=2)
    direct = solve(ex.HOSTS, ex.FAMS, rounds=2, num_workers=1)
    assert plan.total_score == direct.total_score == 341
    assert plan.proven_optimal
    _check_invariants(plan)


def test_templates_match_example_tags():
    ex = _example()
    assert {h.host_id: h.tags for h in load_hosts(HOSTS_CSV)} == {h.host_id: h.tags for h in ex.HOSTS}
    assert {f.group_id: f.interests for f in load_fams(FAMS_CSV)} == {f.group_id: f.interests for f in ex.FAMS}


# ----------------------------------------------------------------------
# Uneven events.
# ----------------------------------------------------------------------


def _toy(n_hosts, n_fams):
    topics = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]
    hosts = [Host.make(f"h{i}", f"Host {i}", f"Host {i}", [topics[i], topics[(i + 1) % 12]]) for i in range(n_hosts)]
    fams = [GuestGroup.make(f"f{i}", f"Fam {i}", [topics[i % 12], topics[(i + 3) % 12]]) for i in range(n_fams)]
    return hosts, fams


def test_more_fams_than_hosts_gives_free_rounds():
    hosts, fams = _toy(8, 10)
    plan = plan_event(hosts, fams, rounds=2)
    _check_invariants(plan)
    assert sum(len(v) for v in plan.free_rounds.values()) == (10 - 8) * 2
    assert len(plan.assignments) == 8 * 2
    assert plan.proven_optimal


def test_more_hosts_than_fams_gives_breaks():
    hosts, fams = _toy(10, 7)
    plan = plan_event(hosts, fams, rounds=3)
    _check_invariants(plan)
    assert sum(len(v) for v in plan.host_breaks.values()) == (10 - 7) * 3
    assert len(plan.assignments) == 7 * 3


def test_too_many_rounds_is_rejected():
    hosts, fams = _toy(3, 3)
    with pytest.raises(InfeasibleProblemError, match="the most rounds without any fam meeting the same host twice is 3"):
        plan_event(hosts, fams, rounds=4)


# ----------------------------------------------------------------------
# Sheets.
# ----------------------------------------------------------------------


def test_sheet_errors_are_collected():
    bad = io.StringIO("table_label,tags,host_id\nPharmacy,,h1\n,medicine,h1\n")
    with pytest.raises(SheetError) as err:
        load_hosts(bad)
    assert err.value.problems == [
        "Row 2 of the host tables has no table name. Add one, or delete the row.",
        "The host table in row 2 has the same row ID (h1) as an earlier row. Delete the copy, or clear the ID in one of them.",
    ]


def test_missing_column_is_named():
    with pytest.raises(SheetError, match=r"missing column\(s\) Interests"):
        load_fams(io.StringIO("fam_label,size\nBio,6\n"))


def test_bad_size_is_reported():
    with pytest.raises(SheetError, match="not a whole number"):
        load_fams(io.StringIO("fam_label,interests,size\nBio,biology,six\n"))


def test_ids_are_generated_and_tags_normalized():
    hosts = load_hosts(io.StringIO("table_label,tags\nPharmacy, Healthcare ; PharmD,\n"))
    assert hosts[0].host_id == "h01"
    assert hosts[0].tags == frozenset({"healthcare", "pharmd"})


def test_vocabulary_warning_catches_spelling_mismatch():
    hosts = [Host.make("h", "MD", "MD", ["premed"])]
    fams = [GuestGroup.make("f", "Bio", ["pre-med"])]
    warnings = " ".join(vocabulary_warnings(hosts, fams))
    assert "premed" in warnings and "pre-med" in warnings
    assert "No host shares any tag with Bio" in warnings


# ----------------------------------------------------------------------
# Exports and CLI.
# ----------------------------------------------------------------------


def test_exports_cover_every_slot():
    hosts, fams = _toy(8, 10)
    plan = plan_event(hosts, fams, rounds=2)
    rows = schedule_rows(plan)
    assert len(rows) == 10 * 2
    assert sum(1 for r in rows if r["host_table"].startswith("Open table")) == 4
    assert schedule_csv(plan).splitlines()[0] == "round,table,fam,host_table,score"
    page = seating_chart_html(plan, title="Test dinner")
    assert "Round 1" in page and "Round 2" in page and "Test dinner" in page
    assert "\u2014" not in page and "\u2013" not in page


def test_cli_writes_files(tmp_path, capsys):
    out_csv, out_html = tmp_path / "s.csv", tmp_path / "s.html"
    code = cli_main(["--hosts", str(HOSTS_CSV), "--fams", str(FAMS_CSV), "--rounds", "2",
                     "--out-csv", str(out_csv), "--out-html", str(out_html)])
    assert code == 0
    assert "Total match score 341" in capsys.readouterr().out
    assert len(out_csv.read_text().splitlines()) == 1 + 10 * 2
    assert "Round 2" in out_html.read_text()


def test_cli_reports_sheet_problems(tmp_path, capsys):
    bad = tmp_path / "hosts.csv"
    bad.write_text("table_label,tags\n,medicine\n")
    code = cli_main(["--hosts", str(bad), "--fams", str(FAMS_CSV), "--rounds", "2"])
    assert code == 2
    assert "Row 1 of the host tables has no table name. Add one, or delete the row." in capsys.readouterr().err
