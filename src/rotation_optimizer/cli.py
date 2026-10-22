"""Command-line entry point: rotation-optimizer --hosts hosts.csv --fams fams.csv --rounds 2.

Prints the schedule and any warnings, and optionally writes a schedule CSV
and a printable seating chart.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .export import schedule_csv, schedule_rows, seating_chart_html
from .planning import plan_event
from .sheets import SheetError, load_fams, load_hosts
from .solver import InfeasibleProblemError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rotation-optimizer",
        description="Find the best rotation schedule for a networking event from two CSV sheets.",
    )
    parser.add_argument("--hosts", required=True, type=Path, help="CSV with table_label and tags columns")
    parser.add_argument("--fams", required=True, type=Path, help="CSV with fam_label and interests columns")
    parser.add_argument("--rounds", required=True, type=int, help="number of rotation rounds")
    parser.add_argument("--out-csv", type=Path, help="write the schedule to this CSV file")
    parser.add_argument("--out-html", type=Path, help="write a printable seating chart to this HTML file")
    parser.add_argument("--title", default="Rotation schedule", help="title for the seating chart")
    parser.add_argument("--time-limit", type=float, default=30.0, help="solver time limit in seconds")
    args = parser.parse_args(argv)

    try:
        hosts = load_hosts(args.hosts)
        fams = load_fams(args.fams)
        plan = plan_event(hosts, fams, args.rounds, time_limit_s=args.time_limit)
    except SheetError as err:
        print("Please fix these sheet problems:", file=sys.stderr)
        for p in err.problems:
            print(f"  {p}", file=sys.stderr)
        return 2
    except (InfeasibleProblemError, OSError) as err:
        print(f"Cannot plan this event: {err}", file=sys.stderr)
        return 2

    status = "proven best possible" if plan.proven_optimal else f"best found, upper bound {plan.objective_bound}"
    print(f"Total match score {plan.total_score} ({status}), solved in {plan.runtime_s:.3f} s.")
    for r in range(1, plan.rounds + 1):
        print(f"\nRound {r}")
        for row in schedule_rows(plan):
            if row["round"] == r:
                print(f"  {row['fam']:<40} {row['host_table']:<36} score {row['score']}")
    if plan.warnings:
        print("\nCheck these before the event:")
        for w in plan.warnings:
            print(f"  {w}")

    if args.out_csv:
        args.out_csv.write_text(schedule_csv(plan))
        print(f"\nWrote {args.out_csv}")
    if args.out_html:
        args.out_html.write_text(seating_chart_html(plan, title=args.title))
        print(f"Wrote {args.out_html}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
