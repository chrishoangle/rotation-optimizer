"""Checks that the project site shows what the code produces.

docs/index.html renders its numbers from docs/site-data.json, which
scripts/export_site_data.py writes. These tests rebuild the data from the
example and compare. They also prove the site's headline: no feasible
schedule for the example avoids a zero-score slot.
"""

from __future__ import annotations

import importlib.util
import json
import re
from collections import Counter
from pathlib import Path

import pytest
from ortools.sat.python import cp_model

from rotation_optimizer import build_score_matrix, solve

ROOT = Path(__file__).resolve().parents[1]
SITE_DATA = ROOT / "docs" / "site-data.json"
SITE_HTML = ROOT / "docs" / "index.html"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def example():
    return _load("stew_dinner", ROOT / "examples" / "stew_dinner.py")


@pytest.fixture(scope="module")
def data():
    return json.loads(SITE_DATA.read_text())


def test_hosts_and_fams_match_example(data, example):
    assert [h["id"] for h in data["hosts"]] == [h.host_id for h in example.HOSTS]
    assert [h["theme"] for h in data["hosts"]] == [h.theme for h in example.HOSTS]
    assert [f["id"] for f in data["fams"]] == [f.group_id for f in example.FAMS]
    assert [f["name"] for f in data["fams"]] == [f.name for f in example.FAMS]


def test_score_matrix_matches_scorer(data, example):
    scores = build_score_matrix(example.HOSTS, example.FAMS)
    for (h, f), s in scores.items():
        assert data["scores"][h][f] == s, (h, f)


def test_total_matches_fresh_solve(data, example):
    """Optimal schedules are not unique, so compare the score, not the pairings."""
    schedule = solve(example.HOSTS, example.FAMS, rounds=data["meta"]["R"])
    assert data["meta"]["total_score"] == schedule.total_score
    assert data["meta"]["objective_bound"] == schedule.objective_bound
    assert data["meta"]["proven_optimal"] is True


def test_exported_schedule_satisfies_c1_c2_c3(data):
    host_ids = sorted(h["id"] for h in data["hosts"])
    fam_ids = sorted(f["id"] for f in data["fams"])
    for r in range(1, data["meta"]["R"] + 1):
        rows = [a for a in data["optimal"] if a["round"] == r]
        assert sorted(a["host"] for a in rows) == host_ids  # C1
        assert sorted(a["fam"] for a in rows) == fam_ids  # C2
    pairs = Counter((a["host"], a["fam"]) for a in data["optimal"])
    assert max(pairs.values()) == 1  # C3


def test_exported_schedule_scores_add_up(data):
    assert all(a["score"] == data["scores"][a["host"]][a["fam"]] for a in data["optimal"])
    assert sum(a["score"] for a in data["optimal"]) == data["meta"]["total_score"]
    totals = Counter()
    for a in data["optimal"]:
        totals[a["fam"]] += a["score"]
    assert dict(totals) == data["fam_totals"]


def test_bottleneck_capacity_is_short(data):
    """The site's counting argument: the listed fams need more nonzero visits than exist."""
    b = data["bottleneck"]
    R = data["meta"]["R"]
    recomputed = 0
    for h in data["scores"]:
        reach = sum(1 for f in b["fams"] if data["scores"][h][f] > 0)
        recomputed += min(R, reach)
    assert recomputed == b["capacity"]
    assert b["demand"] == R * len(b["fams"])
    assert b["capacity"] < b["demand"]


def test_no_feasible_schedule_avoids_a_zero_slot(data):
    """Headline check: forbid every zero-score pair and the model has no solution."""
    hosts = [h["id"] for h in data["hosts"]]
    fams = [f["id"] for f in data["fams"]]
    R = data["meta"]["R"]
    m = cp_model.CpModel()
    x = {
        (h, f, r): m.NewBoolVar(f"x_{h}_{f}_{r}")
        for h in hosts
        for f in fams
        for r in range(R)
        if data["scores"][h][f] > 0
    }
    for r in range(R):
        for h in hosts:
            m.AddExactlyOne([x[h, f, r] for f in fams if (h, f, r) in x])
        for f in fams:
            m.AddExactlyOne([x[h, f, r] for h in hosts if (h, f, r) in x])
    for h in hosts:
        for f in fams:
            if (h, f, 0) in x:
                m.Add(sum(x[h, f, r] for r in range(R)) <= 1)
    status = cp_model.CpSolver().Solve(m)
    assert status == cp_model.INFEASIBLE


def test_html_fallback_numbers_match_data(data):
    """Every <span data-k="..."> in the page shows the JSON value before JS runs."""
    html = SITE_HTML.read_text()
    found = re.findall(r'<span data-k="([a-z_]+)">([^<]*)</span>', html)
    assert found, "no data-k spans found in docs/index.html"
    flat = dict(data["meta"])
    flat["median_fam_total"] = data["median_fam_total"]
    for key, shown in found:
        assert key in flat, key
        assert shown == str(flat[key]), (key, shown, flat[key])
