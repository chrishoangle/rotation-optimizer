"""Turn an EventPlan into files a coordinator can hand out.

schedule_csv()        one row per fam per round, including open tables
run_sheet_html()      the coordinator's night: MC timeline and check-in lists
seating_chart_html()  one page per round, every table with its host
host_cards_html()     one half page per host: where to go each round
table_tents_html()    one folded tent per table: big number and fam name

Every HTML page is self-contained and laid out for US Letter paper.
"""

from __future__ import annotations

import csv
import html
import io
import math
import re

from .planning import FAM_ABSENT, NO_HOST, EventPlan, host_label

_BASE_CSS = """
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e; margin: 0; }
@media screen { body { margin: 24px; } }
"""


_STAMP_CSS = ".stamp { display: inline-block; font-size: 12px; font-weight: 700; color: #8a1c1c; border: 1.5px solid #8a1c1c; border-radius: 4px; padding: 1px 6px; margin: 0 0 6px; }"


def _tag_words(tag: str) -> str:
    """A tag as words on paper: small-business becomes small business, while pre-med stays."""
    return re.sub(r"(?<=[a-z]{4})-(?=[a-z]{4})", " ", tag)


def _stamp(updated: str) -> str:
    """The mark on a reprinted page, so nobody uses the old copy."""
    return f'<div class="stamp">Updated {html.escape(updated)}. Replaces the earlier copy.</div>' if updated else ""


def _counts(plan: EventPlan) -> str:
    """How many fams, alumni, and rounds, counting cancellations."""
    def part(n: int, noun: str, gone: dict, plural: str = "") -> str:
        text = f"{n} {noun if n == 1 else plural or noun + 's'}"
        if gone:
            text += f" ({len(gone)} cancelled from round {min(min(rs) for rs in gone.values())})"
        return text
    return (part(len(plan.fams), "fam", plan.fam_away) + ", " + part(len(plan.hosts), "alum", plan.host_away, "alumni")
            + f", {plan.rounds} round{'s' if plan.rounds != 1 else ''}.")


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


def availability_text(plan: EventPlan, host_id: str) -> str:
    """For a host with an "only in rounds" rule, for example "round 1 only"."""
    present = [r for r in range(1, plan.rounds + 1) if r not in plan.host_limits.get(host_id, [])]
    if not present:
        return "not hosting"
    if len(present) == 1:
        return f"round {present[0]} only"
    return "rounds " + ", ".join(map(str, present[:-1])) + f" and {present[-1]} only"


def seating_chart_html(
    plan: EventPlan, title: str = "Rotation schedule", rounds: list[int] | None = None, finder: bool = True,
    updated: str = "", locations: dict[str, str] | None = None,
) -> str:
    """One section per round, then a find-your-table page. Each starts on a new printed page.

    rounds and finder limit the output to some pages, for reprinting after a re-plan.
    updated, such as "7:42 PM", marks every page as a replacement.
    locations, {fam id: "by the stage"}, says where each table is in the room.
    """
    e = html.escape
    rows = schedule_rows(plan)
    where = {f.name: (locations or {}).get(f.group_id, "") for f in plan.fams}
    hosts = {h.host_id: host_label(h) for h in plan.hosts}
    person = {h.name: h.person for h in plan.hosts if h.person and h.person != h.name}
    sections = []
    stamp = _stamp(updated)
    for r in (rounds or range(1, plan.rounds + 1)):
        cards = "".join(
            f'<div class="card"><div class="num">Table {row["table"]}</div><div class="fam">{e(row["fam"])}</div>'
            + (f'<div class="loc">{e(where[row["fam"]])}</div>' if where.get(row["fam"]) else "")
            + f'<div class="host{"" if row["score"] or row["host_table"] not in (NO_HOST, FAM_ABSENT) else " open"}">'
            f'{e(str(row["host_table"]))}</div>'
            + (f'<div class="who">{e(person[row["host_table"]])}</div>' if row["host_table"] in person else "")
            + '</div>'
            for row in rows if row["round"] == r
        )
        breaks = [hosts[h] for h, rs in plan.host_breaks.items()
                  if r in rs and r not in plan.host_away.get(h, []) and r not in plan.host_limits.get(h, [])]
        away = [hosts[h] for h, rs in plan.host_away.items() if r in rs]
        limited = [f"{hosts[h]}: {availability_text(plan, h)}" for h, rs in plan.host_limits.items()
                   if r in rs and r not in plan.host_away.get(h, [])]
        notes = ""
        if breaks:
            notes += f'<p class="note">No table this round: {e(", ".join(breaks))}</p>'
        if limited:
            notes += f'<p class="note">Not hosting this round: {e("; ".join(limited))}</p>'
        if away:
            notes += f'<p class="note">Cancelled: {e(", ".join(away))}</p>'
        sections.append(f'<section><h2>Round {r}</h2>{stamp}<div class="grid">{cards}</div>{notes}</section>')
    names = find_your_table_rows(plan) if finder else []
    if names:
        items = "".join(f'<tr><td>{e(name)}</td><td class="tn">Table {num}</td><td>{e(fam)}</td></tr>' for name, num, fam in names)
        sections.append(f'<section><h2>Find your table</h2>{stamp}<table class="finder">{items}</table></section>')
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
.host.open {{ color: #b4530a; }} .note {{ color: #5c5c63; font-size: 13px; }} .loc {{ font-size: 12px; color: #5c5c63; }} .who {{ font-size: 13px; }}
section {{ break-before: page; }} section:first-of-type {{ break-before: auto; }}
.finder {{ border-collapse: collapse; width: 100%; columns: 2; }} .finder td {{ border-bottom: 1px solid #e3e0d9; padding: 4px 6px; font-size: 13px; }}
.finder td.tn {{ font-weight: 700; white-space: nowrap; }}
{_STAMP_CSS}
</style></head><body>
<h1>{e(title)}</h1>
<p class="meta">{_counts(plan)}</p>
{''.join(sections)}
</body></html>
"""


def host_cards_html(
    plan: EventPlan, host_ids: list[str] | None = None, title: str = "Host cards", updated: str = "",
    locations: dict[str, str] | None = None,
) -> str:
    """One half-page card per host: table number, fam, and talking points for every round.

    Cards grow to fit and never clip. Two short cards share a page; a card
    too long for half a page gets a page of its own, and so does the card
    after it, so the halves still line up for cutting.

    host_ids limits the output to those hosts, for reprinting after a re-plan.
    locations, {fam id: "by the stage"}, adds where each table is.
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
                shared = sorted(f.interests & h.tags)
                other = sorted(f.interests - h.tags)
                pts = ""
                if shared:
                    pts += f'<div class="pts"><b>You share:</b> {e(", ".join(map(_tag_words, shared)))}</div>'
                if other:
                    pts += f'<div class="pts">{"Also interested in" if shared else "Interested in"}: {e(", ".join(map(_tag_words, other)))}</div>'
                lines.append(
                    f'<tr><td class="r">Round {r}</td><td class="t">Table {tables[f_id]}</td>'
                    f'<td><div class="fam">{e(f.name)}</div>'
                    + (f'<div class="loc">{e(locations[f_id])}</div>' if (locations or {}).get(f_id) else "")
                    + f'{pts}</td></tr>'
                )
            elif r in plan.host_away.get(h.host_id, []):
                lines.append(f'<tr><td class="r">Round {r}</td><td class="t"></td><td><div class="fam">Cancelled for this round</div></td></tr>')
            elif r in plan.host_limits.get(h.host_id, []):
                lines.append(f'<tr><td class="r">Round {r}</td><td class="t"></td><td><div class="fam">Not hosting this round</div></td></tr>')
            else:
                lines.append(f'<tr><td class="r">Round {r}</td><td class="t"></td><td><div class="fam">No table this round</div>'
                             '<div class="pts">More hosts than fams this round. Please wait near the front for the next round.</div></td></tr>')
        cards.append(
            f'<article class="hc{" full" if _card_inches(h, lines) > 4.9 else ""}"><div class="head">{_stamp(updated)}<span class="lbl">Host table</span><h2>{e(h.name)}</h2>'
            + (f'<div class="person">{e(h.person)}</div>' if h.person and h.person != h.name else "")
            + "</div>"
            f'<table>{"".join(lines)}</table><p class="foot">{e(title)}. Move when the MC calls the round.</p></article>'
        )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<style>{_BASE_CSS}
.hc {{ min-height: 4.9in; border: 1px dashed #9a978f; padding: 0.3in 0.35in; display: flex; flex-direction: column; break-inside: avoid; }}
.hc + .hc {{ margin-top: 0.1in; }}
.hc.full {{ min-height: 0; }} .hc.full + .hc {{ break-before: page; }}
.lbl {{ font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #5c5c63; }}
h2 {{ font-size: 26px; margin: 2px 0 2px; }}
.person {{ font-size: 15px; color: #3a3a3f; margin-bottom: 6px; }} .head {{ margin-bottom: 8px; }}
table {{ border-collapse: collapse; width: 100%; }}
td {{ border-top: 1px solid #d6d3cc; padding: 9px 6px; vertical-align: top; }}
td.r {{ width: 1.0in; font-weight: 600; }} td.t {{ width: 1.1in; font-size: 22px; font-weight: 800; }}
.fam {{ font-weight: 700; font-size: 16px; }} .pts {{ font-size: 12.5px; color: #3a3a3f; margin-top: 2px; }} .loc {{ font-size: 12.5px; color: #5c5c63; }}
.foot {{ margin-top: auto; font-size: 11px; color: #5c5c63; }}
{_STAMP_CSS}
</style></head><body>
{''.join(cards) or '<p>No host cards to print.</p>'}
</body></html>
"""


def _card_inches(host, rows: list[str]) -> float:
    """A rough height for a host card on US Letter, to decide whether it fits half a page."""
    text_lines = 0
    for row in rows:
        plain = re.sub(r"<[^>]+>", "\n", row)
        parts = [p for p in plain.split("\n") if p.strip()]
        # About 70 characters fit on a line beside the round and table columns.
        text_lines += sum(max(1, math.ceil(len(p) / 70)) for p in parts[2:]) if len(parts) > 2 else 1
    rows_height = 0.33 * len(rows) + 0.19 * max(0, text_lines - len(rows))
    return 0.6 + 0.75 + (0.25 if host.person else 0) + rows_height + 0.3


def table_tents_html(plan: EventPlan, fam_ids: list[str] | None = None, updated: str = "") -> str:
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
        tents.append(f'<article class="tent">{_stamp(updated)}<div class="flip">{face}</div><div class="fold"></div>{face}</article>')
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
{_STAMP_CSS}
</style></head><body>
{''.join(tents) or '<p>No table tents to print.</p>'}
</body></html>
"""


def find_your_table_rows(plan: EventPlan) -> list[tuple[str, int, str]]:
    """Every guest name with their table number and fam, sorted by name. Empty when no names were entered."""
    tables = _table_numbers(plan)
    rows = [(m, tables[f.group_id], f.name) for f in plan.fams for m in f.members]
    return sorted(rows, key=lambda r: (r[0].lower(), r[1]))


def host_view_rows(plan: EventPlan) -> list[dict[str, str]]:
    """One row per host with where they go each round, for the app's Host view."""
    tables = _table_numbers(plan)
    fams = {f.group_id: f for f in plan.fams}
    by_host = {(a.host_id, a.round_number): a.group_id for a in plan.assignments}
    out = []
    for h in plan.hosts:
        row = {"host_table": h.name}
        if any(x.person for x in plan.hosts):
            row["host_name"] = h.person
        for r in range(1, plan.rounds + 1):
            f_id = by_host.get((h.host_id, r))
            if f_id:
                row[f"round {r}"] = f"Table {tables[f_id]} ({fams[f_id].name})"
            elif r in plan.host_away.get(h.host_id, []):
                row[f"round {r}"] = "Cancelled"
            elif r in plan.host_limits.get(h.host_id, []):
                row[f"round {r}"] = f"Not hosting ({availability_text(plan, h.host_id)})"
            else:
                row[f"round {r}"] = "No table this round"
        out.append(row)
    return out


def _clock(start: str, minutes: int) -> str:
    """start as "18:30" or "6:30 PM" plus minutes, as "7:05 PM". Blank when start is blank or unreadable."""
    import datetime as dt

    text = (start or "").strip().upper().replace(".", "")
    for fmt in ("%H:%M", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p"):
        try:
            t = dt.datetime.strptime(text, fmt)
            break
        except ValueError:
            continue
    else:
        return ""
    t += dt.timedelta(minutes=minutes)
    return t.strftime("%I:%M %p").lstrip("0")


def run_sheet_html(
    plan: EventPlan, title: str = "Run sheet", start_time: str = "", round_minutes: int = 20, welcome_minutes: int = 10,
    switch_minutes: int = 5,
) -> str:
    """The coordinator's page for the night: an MC timeline and a check-in list.

    With a start time, each step gets a clock time; without one, each step
    gets a blank to fill in by hand.
    """
    e = html.escape
    tables = _table_numbers(plan)
    hosts = {h.host_id: h for h in plan.hosts}
    by_host = {(a.host_id, a.round_number): a.group_id for a in plan.assignments}

    steps: list[tuple[int, str, str]] = [
        (0, "Doors open", "Hosts and fams check in on the lists below. Fams sit at their table number."),
        (welcome_minutes, "Welcome", "Welcome everyone. Fams stay seated all night; hosts move between tables each round."),
    ]
    t = welcome_minutes + switch_minutes
    for r in range(1, plan.rounds + 1):
        notes = []
        idle = [h for h in hosts if (h, r) not in by_host]
        out = [host_label(hosts[h]) for h in idle if r in plan.host_away.get(h, [])]
        limited = [host_label(hosts[h]) for h in idle if r in plan.host_limits.get(h, []) and r not in plan.host_away.get(h, [])]
        breaks = [host_label(hosts[h]) for h in idle if r not in plan.host_away.get(h, []) and r not in plan.host_limits.get(h, [])]
        open_tables = [str(tables[f.group_id]) for f in sorted(plan.fams, key=lambda f: tables[f.group_id])
                       if not any(a.round_number == r and a.group_id == f.group_id for a in plan.assignments)
                       and r not in plan.fam_away.get(f.group_id, [])]
        if open_tables:
            notes.append(f"No host at table {', '.join(open_tables)} this round.")
        if breaks:
            notes.append(f"No table this round: {', '.join(breaks)}.")
        if limited:
            notes.append(f"Not hosting this round: {', '.join(limited)}.")
        if out:
            notes.append(f"Cancelled: {', '.join(out)}.")
        say = (f"Round {r} starts. Hosts, go to the table on your host card for round {r}."
               if r == 1 else f"Thank your table. Hosts, move to the table on your host card for round {r}.")
        steps.append((t, f"Round {r}", " ".join([say] + notes)))
        t += round_minutes + (switch_minutes if r < plan.rounds else 0)
    steps.append((t, "Closing", "Thank the hosts and the fams. Collect table tents and host cards."))

    def when(minutes: int) -> str:
        clock = _clock(start_time, minutes)
        return e(clock) if clock else '<span class="blank"></span>'

    timeline = "".join(f'<tr><td class="time">{when(m)}</td><td class="what">{e(what)}</td><td>{e(say)}</td></tr>' for m, what, say in steps)
    # A topic column only when some alum has a topic that is not just their name.
    named = any(h.person and h.person != h.name for h in plan.hosts)
    host_rows = "".join(
        '<tr><td class="box"></td>'
        + (f"<td>{e(h.person or h.name)}</td><td>{e(h.name) if h.person and h.person != h.name else ''}</td>" if named else f"<td>{e(h.person or h.name)}</td>")
        + f'<td>{_first_table(plan, h.host_id, tables, by_host)}</td></tr>'
        for h in plan.hosts
    )
    fam_rows = "".join(
        f'<tr><td class="box"></td><td>Table {tables[f.group_id]}</td><td>{e(f.name)}</td><td>{f.size or len(f.members) or ""}</td></tr>'
        for f in sorted(plan.fams, key=lambda f: tables[f.group_id])
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}: run sheet</title>
<style>{_BASE_CSS}
h1 {{ font-size: 22px; margin: 0 0 4px; }} h2 {{ font-size: 18px; margin: 18px 0 8px; }}
.meta {{ color: #5c5c63; margin: 0 0 8px; }}
table {{ border-collapse: collapse; width: 100%; }} td, th {{ border-bottom: 1px solid #e3e0d9; padding: 6px; vertical-align: top; text-align: left; }}
th {{ font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #5c5c63; }}
.time {{ width: 1.1in; font-weight: 700; white-space: nowrap; }} .what {{ width: 1.3in; font-weight: 700; }}
.blank {{ display: inline-block; width: 0.8in; border-bottom: 1px solid #1c1c1e; }}
.box {{ width: 0.35in; }} .box::before {{ content: ""; display: inline-block; width: 14px; height: 14px; border: 1.5px solid #1c1c1e; }}
section {{ break-before: page; }} section:first-of-type {{ break-before: auto; }}
.help {{ font-size: 13px; color: #3a3a3f; }}
</style></head><body>
<section>
<h1>{e(title)}: run sheet</h1>
<p class="meta">{plan.rounds} rounds, {len(plan.hosts)} alumni, {len(plan.fams)} fams.</p>
<h2>MC timeline</h2>
<table>{timeline}</table>
<h2>If someone cancels during the night</h2>
<p class="help">In the app, open Run the event, tap Someone changed?, then Re-plan.
Tell the people it lists, and hand out change slips if you print them. Rounds already finished never change.</p>
</section>
<section>
<h2>Check-in: alumni</h2>
<table><tr><th></th>{"<th>Alum</th><th>Topic</th>" if named else "<th>Alum</th>"}<th>Round 1</th></tr>{host_rows}</table>
<h2>Check-in: fams</h2>
<table><tr><th></th><th>Table</th><th>Fam</th><th>Students</th></tr>{fam_rows}</table>
</section>
</body></html>
"""


def _first_table(plan: EventPlan, host_id: str, tables: dict[str, int], by_host: dict) -> str:
    """Where a host starts: the first round they have a table."""
    for r in range(1, plan.rounds + 1):
        f_id = by_host.get((host_id, r))
        if f_id:
            return f"Table {tables[f_id]}" + ("" if r == 1 else f" (from round {r})")
    return "No table"
