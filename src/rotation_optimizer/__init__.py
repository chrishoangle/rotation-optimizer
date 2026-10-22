"""rotation_optimizer: find the best rotation schedule for networking events.

Public API:
    Host, GuestGroup, Schedule, Assignment: data models
    tag_overlap_score: default scorer
    build_score_matrix: precomputed scores for every host-group pair
    solve: CP-SAT solver entry point
    InfeasibleProblemError: raised when the constraints cannot be met
"""

from .models import Assignment, GuestGroup, Host, Schedule
from .scoring import build_score_matrix, tag_overlap_score
from .solver import InfeasibleProblemError, solve

__all__ = [
    "Assignment",
    "GuestGroup",
    "Host",
    "InfeasibleProblemError",
    "Schedule",
    "build_score_matrix",
    "solve",
    "tag_overlap_score",
]
