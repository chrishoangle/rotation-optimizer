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

from .models import Assignment, GuestGroup, Host, Schedule
from .scoring import build_score_matrix, tag_overlap_score
from .solver import InfeasibleProblemError, solve
from .sheets import SheetError, fam_id_by_label, host_id_by_label, load_fams, load_hosts, load_schedule
from .planning import (
    EventPlan,
    Rule,
    RuleConflictError,
    SlotChange,
    plan_changes,
    plan_event,
    replan,
    reprint_list,
    vocabulary_warnings,
)
from .export import schedule_csv, schedule_rows, seating_chart_html

__all__ = [
    "Assignment",
    "EventPlan",
    "SheetError",
    "fam_id_by_label",
    "host_id_by_label",
    "load_schedule",
    "replan",
    "reprint_list",
    "plan_changes",
    "Rule",
    "RuleConflictError",
    "SlotChange",
    "load_fams",
    "load_hosts",
    "plan_event",
    "schedule_csv",
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
