**REVISE — one remaining period-comparison defect.** Reviewed `c0a57dc` on `nibrs-engine/answer-policy`.

Tests passed. Runner completed with report writes intercepted: **68 scored (61 development, 7 held out), 0 provisional**. No files changed.

1. **Accepted: filter equivalence and unknown handling.** Exclusions, negated existence and partial firearm sets remain unverified. Unknown components no longer match merely because their placeholders match.

2. **Accepted: unsupported comparison/share details.** Period-comparison parameters and native share `within` now prevent correctness credit. I independently verified the native-share path.

3. **Remaining blocker: clipped year selections ignore their actual ending month.**  
   [compare.ts:199](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:199) requires the expected period to end in December instead of comparing against the resolved `through` month. Using the pinned release, `validateResolved()` returned **no problems** and `{kind:"years", years:[2026], through:"2026-10"}`. Comparison then:
   
   - Falsely marked expected **January–October 2026** as material.
   - Falsely matched expected **January–December 2026**.
   
   Compare effective month boundaries alongside year membership, or conservatively mark clipped selections unverified. Add these two regression cases.

4. **Accepted: zero-wrong-answer gate.** Unverified delivered answers now produce **not measured**, with proven wrong answers correctly taking precedence as **fail**. Previously accepted reporting and scope limitations remain intact.

**Necessity check:** Only the clipped-year defect must change: it produces both false wrong-answer and false correctness results for a supported resolved period. Preserve all accepted work; broader comparator expansion, compiler, routing and continuations remain deferred.
