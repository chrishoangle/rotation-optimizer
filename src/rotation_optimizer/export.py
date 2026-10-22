"""Turn an EventPlan into files a coordinator can hand out.

schedule_csv()        one row per fam per round, including open tables
seating_chart_html()  one page per round, every table with its host
host_cards_html()     one half page per host: where to go each round
table_tents_html()    one folded tent per table: big number and fam name

Every HTML page is self-contained and laid out for US Letter paper.
"""

from __future__ import annotations

import csv
import html
import io

from .planning import EventPlan

NO_HOST = "Open table (no host)"
FAM_ABSENT = "Not attending this round"

_BASE_CSS = """
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; margin: 0; }
@media screen { body { margin: 24px; } }
"""


def _table_numbers(plan: EventPlan) -> dict[str, int]:
    return {f.group_id: (f.table_number or i) for i, f in enumerate(plan.fams, start=1)}


def schedule_rows(plan: EventPlan) -> list[dict[str, object]]:
    """One row per (round, fam), in round then table order."""
    hosts = {h.host_id: h.name for h in plan.hosts}
    tables = _table_numbers(plan)
    by_slot = {(a.round_number, a.group_id): a for a in plan.assignments}
    rows = []
    for r in range(1, plan.rounds + 1):
        for f in sorted(plan.fams, key=lambda f: tables[f.group_id]):
            a = by_slot.get((r, f.group_id))
            if a:
                host = hosts[a.host_id]
            elif r in plan.fam_away.get(f.group_id, []):
                host = FAM_ABSENT
            else:
                host = NO_HOST
            rows.append({
                "round": r,
                "table": tables[f.group_id],
                "fam": f.name,
                "host_table": host,
                "score": a.score if a else 0,
            })
    return rows


def schedule_csv(plan: EventPlan) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=["round", "table", "fam", "host_table", "score"], lineterminator="\n")
    writer.writeheader()
    writer.writerows(schedule_rows(plan))
    return out.getvalue()


def seating_chart_html(plan: EventPlan, title: str = "Rotation schedule") -> str:
    """One section per round. Each round starts on a new printed page."""
    e = html.escape
    rows = schedule_rows(plan)
    hosts = {h.host_id: h.name for h in plan.hosts}
    sections = []
    for r in range(1, plan.rounds + 1):
        cards = "".join(
            f'<div class="card"><div class="num">Table {row["table"]}</div><div class="fam">{e(row["fam"])}</div>'
            f'<div class="host{"" if row["score"] or row["host_table"] not in (NO_HOST, FAM_ABSENT) else " open"}">'
            f'{e(str(row["host_table"]))}</div></div>'
            for row in rows if row["round"] == r
        )
        breaks = [hosts[h] for h, rs in plan.host_breaks.items() if r in rs and r not in plan.host_away.get(h, [])]
        away = [hosts[h] for h, rs in plan.host_away.items() if r in rs]
        notes = ""
        if breaks:
            notes += f'<p class="note">Sitting out this round: {e(", ".join(breaks))}</p>'
        if away:
            notes += f'<p class="note">Cancelled: {e(", ".join(away))}</p>'
        sections.append(f'<section><h2>Round {r}</h2><div class="grid">{cards}</div>{notes}</section>')
    status = "proven best possible" if plan.proven_optimal else "best found, not proven optimal"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<style>{_BASE_CSS}
h1 {{ font-size: 22px; margin: 0 0 4px; }} h2 {{ font-size: 20px; margin: 18px 0 10px; }}
.meta {{ color: #5c5c63; margin: 0 0 8px; }}
.grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }}
.card {{ border: 1px solid #c9c6bf; border-radius: 8px; padding: 8px 10px; break-inside: avoid; }}
.num {{ font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #5c5c63; }}
.fam {{ font-size: 13px; color: #3a3a3f; }} .host {{ font-weight: 700; font-size: 15px; }}
.host.open {{ color: #b4530a; }} .note {{ color: #5c5c63; font-size: 13px; }}
section {{ break-before: page; }} section:first-of-type {{ break-before: auto; }}
</style></head><body>
<h1>{e(title)}</h1>
<p class="meta">{len(plan.fams)} fams, {len(plan.hosts)} host tables, {plan.rounds} rounds. Total match score {plan.total_score} ({status}).</p>
{''.join(sections)}
</body></html>
"""


def host_cards_html(plan: EventPlan, host_ids: list[str] | None = None, title: str = "Host cards") -> str:
    """One half-page card per host: table number, fam, and talking points for every round.

    host_ids limits the output to those hosts, for reprinting after a re-plan.
    """
    e = html.escape
    tables = _table_numbers(plan)
    fams = {f.group_id: f for f in plan.fams}
    by_host: dict[tuple[str, int], str] = {(a.host_id, a.round_number): a.group_id for a in plan.assignments}
    wanted = [h for h in plan.hosts if host_ids is None or h.host_id in host_ids]
    cards = []
    for h in wanted:
        lines = []
        for r in range(1, plan.rounds + 1):
            f_id = by_host.get((h.host_id, r))
            if f_id:
                f = fams[f_id]
                points = ", ".join(sorted(f.interests))
                lines.append(
                    f'<tr><td class="r">Round {r}</td><td class="t">Table {tables[f_id]}</td>'
                    f'<td><div class="fam">{e(f.name)}</div><div class="pts">Ask them about: {e(points)}</div></td></tr>'
                )
            elif r in plan.host_away.get(h.host_id, []):
                lines.append(f'<tr><td class="r">Round {r}</td><td class="t">None</td><td><div class="fam">Cancelled for this round</div></td></tr>')
            else:
                lines.append(f'<tr><td class="r">Round {r}</td><td class="t">None</td><td><div class="fam">Break, no table this round</div></td></tr>')
        cards.append(
            f'<article class="hc"><div class="head"><span class="lbl">Host table</span><h2>{e(h.name)}</h2></div>'
            f'<table>{"".join(lines)}</table><p class="foot">{e(title)}. Move when the MC calls the round.</p></article>'
        )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<style>{_BASE_CSS}
.hc {{ height: 4.9in; border: 1px dashed #9a978f; padding: 0.3in 0.35in; display: flex; flex-direction: column; break-inside: avoid; overflow: hidden; }}
.hc + .hc {{ margin-top: 0.1in; }}
.hc:nth-of-type(2n+1) {{ break-before: page; }} .hc:first-of-type {{ break-before: auto; }}
.lbl {{ font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #5c5c63; }}
h2 {{ font-size: 26px; margin: 2px 0 14px; }}
table {{ border-collapse: collapse; width: 100%; }}
td {{ border-top: 1px solid #d6d3cc; padding: 9px 6px; vertical-align: top; }}
td.r {{ width: 1.0in; font-weight: 600; }} td.t {{ width: 1.1in; font-size: 22px; font-weight: 800; }}
.fam {{ font-weight: 700; font-size: 16px; }} .pts {{ font-size: 12.5px; color: #3a3a3f; margin-top: 2px; }}
.foot {{ margin-top: auto; font-size: 11px; color: #5c5c63; }}
</style></head><body>
{''.join(cards) or '<p>No host cards to print.</p>'}
</body></html>
"""


def table_tents_html(plan: EventPlan, fam_ids: list[str] | None = None) -> str:
    """One tent per table. Fold along the dashed line; both faces read upright from their side."""
    e = html.escape
    tables = _table_numbers(plan)
    wanted = sorted(
        (f for f in plan.fams if fam_ids is None or f.group_id in fam_ids),
        key=lambda f: tables[f.group_id],
    )
    tents = []
    for f in wanted:
        face = f'<div class="face"><div class="n">{tables[f.group_id]}</div><div class="nm">{e(f.name)}</div></div>'
        tents.append(f'<article class="tent"><div class="flip">{face}</div><div class="fold"></div>{face}</article>')
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Table tents</title>
<style>{_BASE_CSS}
@page {{ size: letter; margin: 0.4in; }}
.tent {{ height: 10.1in; display: flex; flex-direction: column; break-after: page; }}
.tent:last-of-type {{ break-after: auto; }}
.face {{ flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }}
.flip {{ flex: 1; display: flex; transform: rotate(180deg); }}
.fold {{ border-top: 1px dashed #9a978f; }}
.n {{ font-size: 220px; font-weight: 800; line-height: 1; }}
.nm {{ font-size: 30px; font-weight: 600; margin-top: 8px; padding: 0 0.3in; }}
</style></head><body>
{''.join(tents) or '<p>No table tents to print.</p>'}
</body></html>
"""
