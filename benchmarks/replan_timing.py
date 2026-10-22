"""Time the night-before cancellation re-plan on the 10x10 STEW example.

Scenario: plan 2 rounds, lock round 1, cancel one host from round 2, and
re-plan round 2 while keeping as many printed slots as possible. For every
host as the cancelled one, the script reports solver runtime, whether the
re-plan was proven optimal under the keep-then-score objective, and how
many round 2 slots changed.

Run from the repo root:
    python benchmarks/replan_timing.py
"""

from __future__ import annotations

import importlib.util
import platform
import statistics
from pathlib import Path

import ortools

from rotation_optimizer import plan_changes, plan_event, replan

EXAMPLE_PATH = Path(__file__).resolve().parents[1] / "examples" / "stew_dinner.py"


def _load_example():
    spec = importlib.util.spec_from_file_location("stew_dinner", EXAMPLE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    ex = _load_example()
    first = plan_event(ex.HOSTS, ex.FAMS, 2)
    print(f"Python {platform.python_version()}, OR-Tools {ortools.__version__}, "
          f"{platform.system()} {platform.machine()}")
    print(f"H = {len(ex.HOSTS)}, G = {len(ex.FAMS)}, R = 2, round 1 locked, one host cancelled from round 2")
    print(f"{'cancelled':>10}  {'runtime_s':>9}  {'proven':>6}  {'changed':>7}")
    times = []
    for h in ex.HOSTS:
        second = replan(first, done_rounds=1, cancel_hosts={h.host_id: 2})
        times.append(second.runtime_s)
        print(f"{h.host_id:>10}  {second.runtime_s:>9.3f}  {'yes' if second.proven_optimal else 'no':>6}  "
              f"{len(plan_changes(first, second)):>7}")
    print(f"median {statistics.median(times):.3f} s, max {max(times):.3f} s over {len(times)} re-plans")


if __name__ == "__main__":
    main()
