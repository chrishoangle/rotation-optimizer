"""Sweep the number of rounds R on the 10x10 STEW example.

The README promises proven optimality in under one second on realistic
problem sizes. This script measures where that holds. For each R it
reports the score, the objective bound, whether the two match (proven
optimal), and the solver runtime, plus the environment that produced them.

Run from the repo root:
    python benchmarks/rounds_sweep.py
"""

from __future__ import annotations

import importlib.util
import platform
from pathlib import Path

import ortools

from rotation_optimizer import solve

EXAMPLE_PATH = Path(__file__).resolve().parents[1] / "examples" / "stew_dinner.py"
ROUNDS = [1, 2, 3, 4, 5, 10]
TIME_LIMIT_S = 10.0


def _load_example():
    spec = importlib.util.spec_from_file_location("stew_dinner", EXAMPLE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    ex = _load_example()
    print(f"Python {platform.python_version()}, OR-Tools {ortools.__version__}, "
          f"{platform.system()} {platform.machine()}")
    print(f"H = {len(ex.HOSTS)}, G = {len(ex.FAMS)}, time limit {TIME_LIMIT_S:.0f} s")
    print(f"{'R':>3}  {'score':>6}  {'bound':>6}  {'proven':>6}  {'runtime_s':>9}")
    for r in ROUNDS:
        s = solve(ex.HOSTS, ex.FAMS, rounds=r, time_limit_s=TIME_LIMIT_S)
        proven = "yes" if s.objective_bound == s.total_score else "no"
        print(f"{r:>3}  {s.total_score:>6}  {s.objective_bound:>6}  {proven:>6}  "
              f"{s.solver_runtime_s:>9.3f}")


if __name__ == "__main__":
    main()
