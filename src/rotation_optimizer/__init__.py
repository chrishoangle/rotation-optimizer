"""rotation_optimizer: find the best rotation schedule for networking events.

Public API:
    Host, GuestGroup, Schedule, Assignment: data models
    tag_overlap_score: default scorer
    build_score_matrix: precomputed scores for every host-group pair
    solve: CP-SAT solver entry point
    InfeasibleProblemError: raised when the constraints cannot be met
    load_hosts, load_fams, SheetError: read coordinator CSV sheets
    plan_event, EventPlan: solve a real event with uneven table counts
    schedule_csv, seating_chart_html: files to hand out
"""

from .models import Assignment, GuestGroup, Host, Schedule
from .scoring import build_score_matrix, tag_overlap_score
from .solver import InfeasibleProblemError, solve
from .sheets import SheetError, load_fams, load_hosts
from .planning import EventPlan, plan_event, vocabulary_warnings
from .export import schedule_csv, schedule_rows, seating_chart_html

__all__ = [
    "Assignment",
    "EventPlan",
    "SheetError",
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
