"""Turn an EventPlan into files a coordinator can hand out.

schedule_csv() gives one row per fam per round, including free rounds.
seating_chart_html() gives a printable page with one section per round.
"""

from __future__ import annotations

import csv
import html
import io

from .planning import EventPlan


def schedule_rows(plan: EventPlan) -> list[dict[str, object]]:
    """One row per (round, fam), in round then fam order."""
    hosts = {h.host_id: h.name for h in plan.hosts}
    by_slot = {(a.round_number, a.group_id): a for a in plan.assignments}
    rows = []
    for r in range(1, plan.rounds + 1):
        for f in plan.fams:
            a = by_slot.get((r, f.group_id))
            rows.append({
                "round": r,
                "fam": f.name,
                "host_table": hosts[a.host_id] if a else "Open table (no host)",
                "score": a.score if a else 0,
            })
    return rows


def schedule_csv(plan: EventPlan) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=["round", "fam", "host_table", "score"])
    writer.writeheader()
    writer.writerows(schedule_rows(plan))
    return out.getvalue()


def seating_chart_html(plan: EventPlan, title: str = "Rotation schedule") -> str:
    """A self-contained printable page. Each round starts on a new printed page."""
    e = html.escape
    rows = schedule_rows(plan)
    hosts = {h.host_id: h.name for h in plan.hosts}
    sections = []
    for r in range(1, plan.rounds + 1):
        cards = "".join(
            f'<div class="card"><div class="fam">{e(row["fam"])}</div>'
            f'<div class="host{" open" if row["host_table"].startswith("Open table") else ""}">{e(str(row["host_table"]))}</div></div>'
            for row in rows if row["round"] == r
        )
        breaks = [hosts[h] for h, rs in plan.host_breaks.items() if r in rs]
        note = f'<p class="note">Sitting out this round: {e(", ".join(breaks))}</p>' if breaks else ""
        sections.append(f'<section><h2>Round {r}</h2><div class="grid">{cards}</div>{note}</section>')
    status = "proven best possible" if plan.proven_optimal else "best found, not proven optimal"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<style>
body {{ font: 15px/1.45 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; margin: 24px; }}
h1 {{ font-size: 24px; margin: 0 0 4px; }} h2 {{ font-size: 20px; margin: 24px 0 10px; }}
.meta {{ color: #5c5c63; margin: 0 0 8px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }}
.card {{ border: 1px solid #d6d3cc; border-radius: 10px; padding: 10px 12px; }}
.fam {{ font-size: 13px; color: #5c5c63; }} .host {{ font-weight: 700; font-size: 16px; }}
.host.open {{ color: #b4530a; }} .note {{ color: #5c5c63; font-size: 14px; }}
@media print {{ section {{ break-before: page; }} section:first-of-type {{ break-before: auto; }} }}
</style></head><body>
<h1>{e(title)}</h1>
<p class="meta">{len(plan.fams)} fams, {len(plan.hosts)} host tables, {plan.rounds} rounds. Total match score {plan.total_score} ({status}).</p>
{''.join(sections)}
</body></html>
"""
