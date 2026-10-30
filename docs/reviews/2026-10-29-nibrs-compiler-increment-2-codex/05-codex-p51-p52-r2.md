**ACCEPT.** (Codex re-review of `af25816..637fa8d`, read-only.) No defects or over-building.

- Known-zero denominator: preserved; expected share null. "Simple assault victims in Detroit by sex by year in 2023 to
  2024" (2023 Female 1/1 -> 100%; 2024 Female 0/0 -> null) replays through delivery and scoring as correct, values
  match, no diffs.
- Missing-month statement: UNAVAILABLE exempt; mutations confirm UNKNOWN and EVIDENCE_CONFLICT still fail without the
  disclosure.
- Absent and unknown denominators leave shares unverified.
- test-nibrs-shadow, test-nibrs-shadow-reading, test-nibrs-compile, test-answer-eval-cases, test-answer-eval-runner pass;
  `git diff --check` passes.

Necessity check: no further changes needed.
