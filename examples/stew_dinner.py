"""End-to-end example: a 10-host, 10-group, 2-round rotation problem.

Models a real alumni networking dinner for admitted UCLA transfer students.
Ten career-themed host tables rotate between ten stationary fam tables of
admits grouped by shared academic interests. The solver finds the schedule
that maximizes career-interest alignment across both rounds, under the
constraint that no fam ever sees the same host twice.

The fam profiles and host themes below mirror the real event. Individual
alumni and admits are described at the group level only: no names, no
emails, no employers, no linkable details. See CASE_STUDY.md for the full
story of the event and the rotation decision.
"""

from __future__ import annotations

from rotation_optimizer import GuestGroup, Host, solve

# ----------------------------------------------------------------------
# Hosts: career-themed tables.
#
# Each entry represents one table hosted by one or two alums whose careers
# share a theme. The tag list captures the kinds of questions a student at
# that table could meaningfully ask. Pair structure (solo vs duo) matters
# for conversation dynamics but not for the solver, which treats each table
# as one host unit.
# ----------------------------------------------------------------------

HOSTS = [
    Host.make(
        "h01",
        "Physician (MD) table",
        "Physician (MD)",
        [
            "medicine",
            "internal medicine",
            "residency",
            "pre-med",
            "healthcare",
            "endocrinology",
        ],
    ),
    Host.make(
        "h02",
        "Pharmacy table",
        "Pharmacy",
        [
            "pharmacy",
            "pharmd",
            "small-business",
            "healthcare",
            "pharmacy ownership",
        ],
    ),
    Host.make(
        "h03",
        "Therapy & Rehab table",
        "Therapy & Rehab",
        [
            "occupational therapy",
            "physical therapy",
            "physician assistant",
            "allied health",
            "healthcare",
        ],
    ),
    Host.make(
        "h04",
        "Aerospace & Defense table",
        "Aerospace & Defense",
        [
            "aerospace",
            "defense",
            "engineering",
            "mechanical engineering",
            "industry",
        ],
    ),
    Host.make(
        "h05",
        "Nonprofit & Social Impact table",
        "Nonprofit & Social Impact",
        [
            "nonprofit",
            "fundraising",
            "advocacy",
            "education reform",
            "public service",
            "development",
        ],
    ),
    Host.make(
        "h06",
        "Physics & Engineering table",
        "Physics & Engineering",
        [
            "physics",
            "engineering",
            "test engineering",
            "mentorship",
            "applied physics",
        ],
    ),
    Host.make(
        "h07",
        "Pre-Med Mentorship table",
        "Pre-Med Mentorship",
        [
            "pre-med",
            "gap years",
            "med school",
            "mentorship",
            "healthcare",
            "application process",
        ],
    ),
    Host.make(
        "h08",
        "Semiconductor & Chip Engineering table",
        "Semiconductor & Chip Engineering",
        [
            "semiconductor",
            "chip",
            "hardware",
            "engineering",
            "computer engineering",
            "electrical engineering",
        ],
    ),
    Host.make(
        "h09",
        "Urban Planning & Public Service table",
        "Urban Planning & Public Service",
        [
            "urban planning",
            "public service",
            "housing",
            "humanities",
            "policy",
            "local government",
        ],
    ),
    Host.make(
        "h10",
        "Admissions & Higher Ed table",
        "Admissions & Higher Ed",
        [
            "admissions",
            "higher education",
            "humanities",
            "consulting",
            "mentorship",
            "student affairs",
        ],
    ),
]

# ----------------------------------------------------------------------
# Guest fams: stationary tables, each with a tag profile derived from the
# collective majors and interests of the admits at that fam. Profiles come
# from the real event. Individual admits are not named; interests describe
# the fam as a whole.
# ----------------------------------------------------------------------

FAMS = [
    GuestGroup.make(
        "fam_01",
        "Public Affairs & Communications fam",
        interests=[
            "political science",
            "communications",
            "public affairs",
            "math economics",
            "digital media",
            "policy",
            "humanities",
        ],
        size=6,
    ),
    GuestGroup.make(
        "fam_02",
        "Cog Sci & Pre-Health fam",
        interests=[
            "cognitive science",
            "mathematics",
            "nursing",
            "biochemistry",
            "pre-med",
            "healthcare",
        ],
        size=6,
    ),
    GuestGroup.make(
        "fam_03",
        "Humanities & Social Sciences fam",
        interests=[
            "philosophy",
            "history",
            "sociology",
            "political science",
            "humanities",
            "public service",
            "higher education",
        ],
        size=6,
    ),
    GuestGroup.make(
        "fam_04",
        "Engineering + Pre-Med fam",
        interests=[
            "mechanical engineering",
            "aerospace",
            "electrical engineering",
            "computer engineering",
            "engineering",
            "pre-med",
            "healthcare",
        ],
        size=7,
    ),
    GuestGroup.make(
        "fam_05",
        "Linguistics, CS & Applied Math fam",
        interests=[
            "linguistics",
            "computer science",
            "applied mathematics",
            "physics",
            "engineering",
            "computer engineering",
        ],
        size=7,
    ),
    GuestGroup.make(
        "fam_06",
        "Sociology & Public Service fam",
        interests=[
            "sociology",
            "political science",
            "nonprofit",
            "public service",
            "advocacy",
            "humanities",
            "policy",
        ],
        size=7,
    ),
    GuestGroup.make(
        "fam_07",
        "Psychology, Data Theory & Math fam",
        interests=[
            "psychology",
            "data theory",
            "mathematics",
            "pre-med",
            "mentorship",
            "allied health",
        ],
        size=7,
    ),
    GuestGroup.make(
        "fam_08",
        "Economics & Business Econ fam",
        interests=[
            "economics",
            "business economics",
            "small-business",
            "consulting",
            "entrepreneurship",
            "stats",
            "data science",
        ],
        size=7,
    ),
    GuestGroup.make(
        "fam_09",
        "Engineering & Psych fam",
        interests=[
            "electrical engineering",
            "chemical engineering",
            "mechanical engineering",
            "engineering",
            "physics",
            "psychology",
            "applied mathematics",
        ],
        size=7,
    ),
    GuestGroup.make(
        "fam_10",
        "Bio & Chem fam",
        interests=[
            "biology",
            "chemistry",
            "biochemistry",
            "psychology",
            "pre-med",
            "healthcare",
            "allied health",
        ],
        size=7,
    ),
]

# ----------------------------------------------------------------------
# Short notes about each fam, kept out of the solver's tag space so they
# do not affect the match score. These power the printed output and the
# case-study document. Each note describes the fam as a group, never an
# individual admit.
# ----------------------------------------------------------------------

FAM_NOTES: dict[str, str] = {
    "fam_01": (
        "Six admits with a strong public-service and media bent. Political "
        "science, communications leaning digital humanities and TV, pre-"
        "public-affairs, and public affairs with math econ. Low pre-med "
        "signal, high interest in policy and storytelling."
    ),
    "fam_02": (
        "Six admits weighted toward cognitive science and pre-health. "
        "Nursing, biochemistry, and math round out the group. Several "
        "admits exploring pre-med pathways."
    ),
    "fam_03": (
        "Six admits anchored in humanities and social sciences. Philosophy, "
        "history (one with an English minor), sociology, and political "
        "science. The fam most likely to ask what a non-STEM UCLA path "
        "actually looks like after graduation."
    ),
    "fam_04": (
        "Seven admits leaning heavily engineering (mechanical, aerospace, "
        "electrical, computer) with two MCDB and microbiology admits "
        "leaning pre-med. Interesting dual character: the engineering "
        "block fits aerospace and semiconductor tables, the pre-med "
        "block fits the MD and pre-med mentorship tables."
    ),
    "fam_05": (
        "Seven admits across linguistics, computer science, and applied "
        "math. Several linguistics-plus-CS or linguistics-plus-psychology "
        "combinations, plus physics with applied math and stats. The "
        "fam most interested in technical careers that are not pure "
        "engineering."
    ),
    "fam_06": (
        "Seven admits with four in sociology, plus political science and "
        "engineering geology. The strongest social-sciences fam of the "
        "night. Natural fit for nonprofit and public-service tables."
    ),
    "fam_07": (
        "Seven admits combining psychology, data theory, and math for "
        "teaching. Several admits exploring pre-med through psychology "
        "or psychobiology. Benefits from both pre-med mentorship and "
        "allied-health perspectives."
    ),
    "fam_08": (
        "Seven admits in economics and business economics, with a "
        "psychology-plus-entrepreneurship admit at the edge. The fam most "
        "likely to ask about business ownership, consulting, and the "
        "operations side of any industry."
    ),
    "fam_09": (
        "Seven admits combining engineering (electrical, chemical, "
        "mechanical) with psychology. The engineering block fits aerospace "
        "and physics tables cleanly, and the psych-adjacent admits fit "
        "allied-health perspectives."
    ),
    "fam_10": (
        "Seven admits in biology, chemistry, and biochemistry, plus "
        "psychology. The purest pre-med fam of the night. Natural fit "
        "for the physician and therapy tables."
    ),
}


def main() -> None:
    schedule = solve(HOSTS, FAMS, rounds=2)

    print("=" * 72)
    print(f"Total match score: {schedule.total_score}")
    print(
        f"Objective bound:   {schedule.objective_bound} "
        f"({'PROVED OPTIMAL' if schedule.total_score == schedule.objective_bound else 'bound differs'})"
    )
    print(f"Solver runtime:    {schedule.solver_runtime_s:.3f} s")
    print("=" * 72)

    hosts_by_id = {h.host_id: h for h in HOSTS}
    fams_by_id = {g.group_id: g for g in FAMS}

    for r in [1, 2]:
        print(f"\n--- Round {r} ---")
        for a in schedule.by_round(r):
            fam_label = fams_by_id[a.group_id].name
            host_label = hosts_by_id[a.host_id].theme
            print(
                f"  {fam_label:<42}  <-  {host_label:<36}  (score {a.score})"
            )

    print("\n--- Per-fam totals (fairness check) ---")
    totals = schedule.per_group_scores()
    for gid in sorted(totals):
        bar = "#" * (totals[gid] // 10)
        print(f"  {fams_by_id[gid].name:<42}  {totals[gid]:>4}  {bar}")

    sorted_scores = sorted(totals.values())
    median = sorted_scores[len(sorted_scores) // 2]
    print(f"\n  Median per-fam total: {median}")
    weak = [gid for gid, s in totals.items() if s < median * 0.6]
    if weak:
        print("  Below 60% of median (coach these fam heads):")
        for gid in weak:
            print(f"    - {fams_by_id[gid].name}  ({totals[gid]})")
    else:
        print("  No fams significantly below median.")


if __name__ == "__main__":
    main()
