"""rotation_optimizer: find the best rotation schedule for networking events.

Public API:
    Host, GuestGroup, Schedule, Assignment: data models
    tag_overlap_score: default scorer
    build_score_matrix: precomputed scores for every host-group pair
    solve: CP-SAT solver entry point
    InfeasibleProblemError: raised when the constraints cannot be met
    load_hosts, load_fams, SheetError: read coordinator CSV sheets
    plan_event, EventPlan: solve a real event with uneven table counts and rules
    replan: keep finished rounds and re-solve the rest after a change
    load_schedule: read a schedule CSV back for replanning
    schedule_csv, seating_chart_html: files to hand out
"""

__version__ = "0.2.0"
RELEASE_DATE = "2026-10-22"

from .models import Assignment, GuestGroup, Host, Schedule
from .scoring import build_score_matrix, tag_overlap_score
from .solver import InfeasibleProblemError, solve
from .sheets import (
    SheetError,
    fam_id_by_label,
    host_id_by_label,
    load_fams,
    load_hosts,
    load_schedule,
    parse_rule_rows,
    removed_after_lock,
)
from .planning import (
    EventPlan,
    Rule,
    RuleConflictError,
    Reprint,
    SlotChange,
    fairness_warnings,
    slot_text,
    plan_changes,
    plan_event,
    replan,
    reprint_list,
    vocabulary_warnings,
)
from .export import (
    find_your_table_rows,
    host_cards_html,
    host_view_rows,
    run_sheet_html,
    schedule_csv,
    schedule_rows,
    seating_chart_html,
    table_tents_html,
)

__all__ = [
    "Assignment",
    "EventPlan",
    "SheetError",
    "fam_id_by_label",
    "host_id_by_label",
    "load_schedule",
    "parse_rule_rows",
    "removed_after_lock",
    "replan",
    "run_sheet_html",
    "reprint_list",
    "plan_changes",
    "Rule",
    "RuleConflictError",
    "SlotChange",
    "Reprint",
    "fairness_warnings",
    "slot_text",
    "load_fams",
    "load_hosts",
    "plan_event",
    "schedule_csv",
    "host_cards_html",
    "host_view_rows",
    "find_your_table_rows",
    "table_tents_html",
    "schedule_rows",
    "seating_chart_html",
    "vocabulary_warnings",
    "GuestGroup",
    "Host",
    "InfeasibleProblemError",
    "Schedule",
    "build_score_matrix",
    "solve",
    "tag_overlap_score",
]
