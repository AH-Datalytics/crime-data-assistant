# Codex review 03: re-check of review 02's fixes (REVISE)

Commit f558ebb. Reviewed 2026-10-30 (same Codex thread). test-nibrs-shadow passes; probes in memory only; no edits, no
scored runs, builds or servers.

Resolved: 1 (year sets), 2 (conflicts refuse rankings), 5 (combined headline number), 7 (no sheriff/police match),
8 (no-population wording). Partly: 3, 4, 6, which led to:

A. P1, places-answer.ts:129: with bindings fixed, several agencies by year reached a branch using only the first
   agency (Tulsa + Oklahoma City combined by year gave 60 a year, not 120). Decline several agencies by year.
B. P2, answer.ts:237: one agency named twice with "combined" declined as "several crimes". Answer it as that agency.
C. P2, shadow.ts:481/487: the P60 parser read "the largest X" as the first name, and two names repeated passed.
   Fix the parser and require distinct names. Not verifying the size order (no populations in the left-out list) is
   acceptable.

Each with a small offline regression.
