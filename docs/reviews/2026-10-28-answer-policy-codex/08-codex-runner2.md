**REVISE.** The outcome and reporting corrections are accepted, but comparison still grants false correctness credit.

Tests passed. The runner completed at `39941f2`, with writes intercepted in memory: **164 eligible labels; 68 scored cases—61 development, 7 held out; 0 provisional**. No files changed.

1. **Accepted: observed actions and decline/clarification outcomes.**  
   `no_reading` stays observed and becomes incomplete when decline was expected. Unjudged decline reasons and unstructured clarification options no longer earn correctness credit. Missing required alternatives remain incomplete.

2. **Remaining blocker: filter normalization still erases meaning.**  
   [compare.ts:48](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:48) generally ignores operators; the adapter discards `exists.negate`. Any subset of firearm codes becomes “firearm.” Executed probes all returned `[]` → **correct** for:
   
   - Expected knife; actual `not_in ["20"]`.
   - Expected knife; actual negated knife existence.
   - Expected all firearms; actual handgun-only code `"12"`.
   
   Require exact equivalence, including operator, negation and value coverage. Unsupported forms can simply be **unverified**. Otherwise these differences can change counts while passing comparison. The regression asserting `["11","12"]` equals all firearms preserves this problem.

3. **Remaining blocker: some omitted plan details still count as matches.**  
   [compare.ts:150](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:150) tracks rolling windows and bins as unverified, but omits period-comparison parameters and native `share` denominator/grain semantics. The years branch also compares year numbers without month boundaries. Probes returned **correct** for:
   
   - June–August 2025 expected versus whole-year 2025 actual.
   - Changing a comparison’s baseline from 2023 to 2024.
   - A native `share` whose denominator semantics were never verified.
   
   Preserve month boundaries; mark unsupported comparison/share parameters unverified. Rank direction/limit, multiple-place combination and ratio-role uncertainty are improvements worth retaining.

4. **Remaining blocker: unknown versus unknown becomes a match.**  
   [compare.ts:172](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:172) emits unverified only when normalized arrays differ. Two different unknowns both become `null`, compare equal, and earn correctness credit. Probes confirmed **victim ethnicity versus offender ethnicity**, and **White versus Black race filters**, both return `[]` → correct. Any unresolved component must remain unverified, even when its placeholder matches another placeholder. This directly contradicts the new three-verdict contract.

5. **Gate correction still needed: unverified answers cannot establish zero wrong answers.**  
   [gates.ts:86](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/gates.ts:86) reports the wrong-answer category as **pass** whenever no `wrong_answer` outcome exists. A probe containing only an unverified answer reports `pass (0)`. Use **not measured** when delivered plan answers remain unverified, unless a proven wrong answer already makes it fail. The repaired mandatory clarification/decline checks, split grouping, numeric “not measured” status and trend-only severity are accepted.

6. **Accepted: separate reporting and coverage dimensions.**  
   Development and held-out results now have separate outcomes, confusion matrices and gates. Execution eligibility and label eligibility are separately visible; spanning eras are distinguished. The report clearly labels provisional results as non-gating.

7. **Accepted: scope disclosure; regression coverage needs the remaining counterexamples.**  
   Missing compiler/results, routing, delivered statements, follow-ups and continuations are explicitly disclosed. They need not be implemented to accept an honestly limited reader evaluation. The existing tests pass but miss the counterexamples above; add focused regressions alongside the consolidated correction.

**Necessity check:** Fix the remaining false-match paths and unsupported zero-wrong-answer pass before trusting these measurements. The shortest route is conservative **unverified** verdicts where equivalence cannot be established—not a larger semantic-comparison build. Preserve the accepted outcome/reporting work; compiler, routing and continuation implementation remain deferred.
