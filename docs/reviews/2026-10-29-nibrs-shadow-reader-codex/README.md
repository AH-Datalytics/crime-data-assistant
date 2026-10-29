# Codex reviews: NIBRS shadow reader round (2026-10-29)

| # | Subject | Commit | Verdict | Applied in |
|---|---|---|---|---|
| 00 | Design: one common agency/place crosswalk | (question) | Recommends a shared registry in nibrs-model; keep the stand-in index for this round | proposal sent |
| 01 | Labels of the 25 fresh held-out cases LS-246..LS-270, before any reader change ran | 75dfdb7 | **ACCEPT** all 25 | frozen |
| 02 | Reader round: the reading pre-pass | 8155b81 | REVISE (4: real words corrected; alternative bindings and scope; P01 on details; forecast vs future period; and the claims) | r2 |

Evidence for before/after claims: `scripts/fixtures/answer-eval/runs/nibrs-shadow-before-reader.{json,md}` is the shadow
run at 2f3cb1c (pre-reader code, labels frozen), kept as the baseline. Its two wrong answers are LS-266 (motor vehicle
theft answered from NIBRS: a real misreading) and LS-258 (the answer-text check's missing "Bureau": a scoring artifact,
fixed in 8155b81). Batch 3 values were not in yet at the baseline, so its fresh "correct" count is not comparable;
avoidable declines (13 -> 3) and wrong answers are.
