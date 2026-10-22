"""Export the data behind the project site to docs/site-data.json.

The site in docs/index.html renders every number from this file, and
tests/test_site_data.py checks the file against a fresh solve. Rerun this
script whenever examples/stew_dinner.py, the scorer, or the solver changes,
and commit the regenerated JSON in the same commit.

Run from the repo root:
    python scripts/export_site_data.py
"""

from __future__ import annotations

import importlib.util
import json
import platform
from itertools import combinations
from pathlib import Path

import ortools

from rotation_optimizer import build_score_matrix, solve

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_PATH = ROOT / "examples" / "stew_dinner.py"
OUT_PATH = ROOT / "docs" / "site-data.json"
ROUNDS = 2


def load_example():
    """Import examples/stew_dinner.py by path, since examples/ is not a package."""
    spec = importlib.util.spec_from_file_location("stew_dinner", EXAMPLE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def find_bottleneck(host_ids, fam_ids, scores, rounds):
    """Return the set of fams with the largest shortfall of nonzero visits.

    Each fam needs `rounds` visits from distinct hosts that score above zero
    with it. A host can make at most `rounds` visits in total, and at most one
    to any single fam. So a set of fams S can receive at most
    sum over hosts h of min(rounds, number of fams in S that h scores above
    zero with). If that capacity is below rounds * |S|, some fam in S must
    get a zero-score slot in every feasible schedule. The shortfall, demand
    minus capacity, is a lower bound on the number of zero-score slots in any
    feasible schedule. All subsets are checked by brute force, and the
    smallest subset with the largest shortfall is returned.
    """
    nonzero = {f: [h for h in host_ids if scores[h, f] > 0] for f in fam_ids}
    best = None
    for size in range(1, len(fam_ids) + 1):
        for subset in combinations(fam_ids, size):
            capacity = {}
            for h in host_ids:
                reach = sum(1 for f in subset if scores[h, f] > 0)
                if reach:
                    capacity[h] = min(rounds, reach)
            demand = rounds * len(subset)
            shortfall = demand - sum(capacity.values())
            if shortfall > 0 and (best is None or shortfall > best["shortfall"]):
                best = {
                    "fams": list(subset),
                    "nonzero_hosts": {f: nonzero[f] for f in subset},
                    "host_capacity": capacity,
                    "demand": demand,
                    "capacity": sum(capacity.values()),
                    "shortfall": shortfall,
                }
    return best


def build_site_data() -> dict:
    ex = load_example()
    hosts, fams = ex.HOSTS, ex.FAMS
    scores = build_score_matrix(hosts, fams)
    schedule = solve(hosts, fams, rounds=ROUNDS, num_workers=1)

    totals = schedule.per_group_scores()
    ordered = sorted(totals.values())
    median = ordered[len(ordered) // 2]  # same rule as examples/stew_dinner.py

    host_ids = [h.host_id for h in hosts]
    fam_ids = [f.group_id for f in fams]
    hand = [
        {"round": r, "host": h, "fam": f, "score": scores[h, f]}
        for r, rnd in sorted(ex.HAND_SCHEDULE.items())
        for f, h in sorted(rnd.items())
    ]
    hand_total = sum(a["score"] for a in hand)
    bottleneck = find_bottleneck(host_ids, fam_ids, scores, ROUNDS)
    return {
        "meta": {
            "python": platform.python_version(),
            "ortools": ortools.__version__,
            "H": len(hosts),
            "G": len(fams),
            "R": ROUNDS,
            "total_score": schedule.total_score,
            "objective_bound": schedule.objective_bound,
            "proven_optimal": schedule.total_score == schedule.objective_bound,
            "runtime_s": round(schedule.solver_runtime_s, 3),
            "admits": sum(f.size for f in fams),
            "hand_total": hand_total,
            "hand_zeros": sum(1 for a in hand if a["score"] == 0),
            "solver_zeros": sum(1 for a in schedule.assignments if a.score == 0),
            "min_zero_slots": bottleneck["shortfall"] if bottleneck else 0,
            "gap_pct": round(100 * (schedule.total_score - hand_total) / schedule.total_score, 1),
        },
        "hosts": [
            {"id": h.host_id, "theme": h.theme, "tags": sorted(h.tags)} for h in hosts
        ],
        "fams": [
            {
                "id": f.group_id,
                "name": f.name,
                "size": f.size,
                "interests": sorted(f.interests),
                "note": ex.FAM_NOTES.get(f.group_id, ""),
            }
            for f in fams
        ],
        "scores": {h: {f: scores[h, f] for f in fam_ids} for h in host_ids},
        "optimal": [
            {"round": a.round_number, "host": a.host_id, "fam": a.group_id, "score": a.score}
            for a in sorted(schedule.assignments, key=lambda a: (a.round_number, a.group_id))
        ],
        "fam_totals": {f: totals[f] for f in fam_ids},
        "median_fam_total": median,
        "hand": hand,
        "bottleneck": bottleneck,
    }


def main() -> None:
    data = build_site_data()
    OUT_PATH.write_text(json.dumps(data, indent=2) + "\n")
    m = data["meta"]
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}: score {m['total_score']}, "
          f"bound {m['objective_bound']}, {m['runtime_s']} s")


if __name__ == "__main__":
    main()
