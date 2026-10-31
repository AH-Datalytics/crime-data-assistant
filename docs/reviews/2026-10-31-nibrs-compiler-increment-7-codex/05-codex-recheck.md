# Codex review 05: re-check of review 04's fixes (01f0717..745b516)

Reviewed 2026-10-31, read-only, no network. Verdict: **REVISE** (one P2).

Verified: Denver juvenile arrests answer 1,114 (Group A 939 plus Group B 175, from separately executed branches); `pair_condition` and `pair_linked` agree across the compiler, the envelope rules and the scorer; arrests by victim race decline; the unknown-value wording and the reader test are corrected; LS-392 expects no agency alternative; the suites pass.

1. **P2: the victim-attribute rewrite left a stale ledger.** "Aggravated assault victims in Tulsa in 2024, by victim race" declined with "couldn't interpret 'race'": the rewritten text was not accounted again when no people flag was set.
   - Applied: any rewrite by readPeople makes the accounting read the rewritten text.
   - The reader test checks the ledger (a race breakdown, nothing unread), and the shadow test checks the answered plan's victim.race grouping.
