# Codex reviews: compiler increment 1, delivered breakdowns (2026-10-29)

| # | Subject | Commit | Verdict | Applied in |
|---|---|---|---|---|
| 00 | Compiler-completion plan r1 | (plan) | Revise the batching; start with delivering accepted breakdowns | plan r2 |
| 01 | Labels of the 13 fresh held-out breakdown cases LS-271..LS-283, before the change | ddd0942 | **ACCEPT** all 13; LS-278 must answer; count-only tables cannot pass | frozen |
| 02 | Increment 1: delivered breakdowns | acbecc4 | REVISE (victim-only sex phrasing; breakdown scoring; blank wording; wait for V41-V49) | 8220283 (r2) |
| 03 | Increment 1 r2 | 8220283 | **ACCEPT (fixes)**; increment acceptance waits on V41-V49 (counts, statuses, shares, share statuses) | 32bd7a2 |
| 04 | Increment 1 with V41-V49 | 32bd7a2 | **ACCEPT** (nonblocking: P29 false-positive refusals, e.g. "reported by women", to fix before offender numbers are delivered) | |

Independent values: nibrs-model batch 4, V41-V49, main f3a7334 (raw master files; canonical cross-check 1,220 cells, 0
differences). With them, the 9 must-answer breakdowns (LS-271..LS-279) score correct: every count, count status and
share matches, and per-year shares are checked against each year's independent total from the measure's own month
cells. Share statuses, compared directly, as review 03 asked: 106 rows, 0 mismatches. The 4 boundaries still decline;
development is unchanged; there are zero wrong answers.
