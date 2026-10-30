# Codex review 02: the increment-5 build, full review (REVISE)

Branch nibrs-engine/compiler-increment-5 at 2c9b92c. Reviewed 2026-10-30 (after one stall). test-nibrs-shadow,
test-nibrs-preview and test-answer-eval-runner pass; findings from static tracing; no edits or heavy work.

1. P1, answer.ts:231: historical-file answers dropped the time form: a part-year comparison became whole years; "by
   month" became an annual total. Decline unsupported time forms.
2. P1, answer.ts:225: "only agencies that reported every month" was lost when a Part I question routed to the
   historical file. The explicit cohort must survive source selection.
3. P1, answer.ts:225: "murder incidents" became the historical victim total. Unsupported units must not become the
   file's unit.
4. P1, state-sum.ts:84: EVIDENCE_CONFLICT months were silently omitted from state sums.
5. P1, state-sum.ts:65: a missing agency population became 0 in rates and coverage.
6. P2, answer.ts:228: a span reaching the current year routed wholly to Current Trends, losing its historical years;
   a future year also routed.
7. P2, answer.ts:210: the Homicide Reports route ignored "according to NIBRS" (P01).
8. P2, state-sum.ts:124: a single year grouped by year delivered a blank Year cell and failed the contract.
9. P2, shadow.ts:397: the P61 disclaimer check used substring searches ("14 agencies" passes for 4).
