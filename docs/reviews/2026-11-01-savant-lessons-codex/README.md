# Codex design check: Savant lessons (2026-11-01)

Note: docs/superpowers/specs/2026-11-01-savant-lessons-design.md

## 01: REVISE (P2 only); every item applied
1. Decision 2 mixed reusing the eligibility test with reusing P61's policy. Rankings fall under P60 (complete reporters only, no include-others button), and named-agency totals and rates under P58. Applied: the decision is split by row, sharing the test only.
2. Domestic violence's crimes were called "crimes against persons", but the list included robbery (120, a property crime) and left out 100, 36A and 36B. Applied: an explicit scope decision. 09C is excluded, robbery is Jeff's choice, and 100, 36A and 36B are included.
3. D20 was overstated: it adds relationships, not the crime scope or the grouping. Applied: D20's scope is stated, and cohabitants (CO, non-intimate) go under "family or household" or a group of their own (decision 3(d)).
4. Two Savant comparisons were wrong. Savant counts only months with crime records, while the engine also counts explicit zero reports. Gun violence's units are the same as P31's. Applied: corrected; the engine's rule is kept.
5. The DV baseline had the wrong years (2018–2020) and was used as expected values. Applied: the years are corrected, Savant's figures are diagnostics only, and expected values wait for decision 3.

Held-out cases added per the review: a second qualifying offender, repeats, each D20 addition, the 09C and 120 boundaries, and the fixed-set button with an explicit zero against an unknown month.

Per review discipline, one design check; no further rounds before Jeff's decisions.
