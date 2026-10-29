**REVISE.** The runner is useful diagnostically, but its correctness claims and gates are not yet trustworthy.

Validation: `npx tsx scripts/test-answer-eval-runner.ts` passed. I executed `scripts/run-answer-eval.ts` using committed `d4da916` labels, intercepting report writes in memory. Result: **4 scored, 70 provisional, 214 not scored**. No files edited; existing workspace changes preserved.

1. **Blocker: missing readings become “correct declines.”**  
   [run-answer-eval.ts:71](C:/Users/jeffm/cda-answer-policy/scripts/run-answer-eval.ts:71) changes `no_reading` to `decline` when the *expected* action is decline. All four scored successes—LS-005, LS-009, LS-012, LS-020—come from this conversion. No truthful explanation was delivered or checked. It also bypasses the alternative-completeness check, which runs before conversion. Ordinary declines never have their reason checked either. Preserve the observed action and mark unverified truthfulness explicitly; otherwise the reported pass certifies behavior that did not occur.

2. **Blocker: normalization hides material differences.**  
   [compare.ts:75](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:75) strips filter values, operators, scope and measure attachment; deduplicates measures independently of their role; and recognizes a share from matching base measure IDs alone. [compare.ts:105](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:105) normalizes the actual statistic using the *expected* units. Executed probes returned **no differences** for:
   
   - Firearm versus knife filters.
   - Inverting the numerator and denominator of `SUBSET_SHARE`.
   - Expected clearance share versus actual population rate.
   - Swapping victim/offense units between two measures.
   
   These can certify genuinely different answers. Preserve numerator/denominator roles, measure–unit associations and filter semantics; normalize only demonstrated equivalents.

3. **Blocker: other answer-defining fields disappear.**  
   [compare.ts:60](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:60) identifies local places by their first word: Los Angeles and Los Banos in California compare equal. `combine`, denominator and rank details are not compared. Noncontiguous years become one continuous interval; grouping bins and transform parameters disappear. Probes confirmed combined versus separate geography also compares equal. Compare these details where represented; where the label cannot express them, report the comparison as unverified rather than correct.

4. **Blocker: naming uncertainty produces both false failures and false successes.**  
   [compare.ts:108](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/compare.ts:108) treats unfamiliar measure/filter/grouping vocabulary as material by default. The run flags, for example, “clearance status” versus `clearance_type`; a probe flags theft versus larceny-theft. Conversely, an unknown period rule produces only a naming difference, which scoring treats as correct—and the Markdown discrepancy list omits correct cases. Use explicit equivalence mappings and an unresolved-comparison status. Unrecognized wording should neither prove a wrong answer nor earn correctness credit.

5. **Blocker: gates do not enforce all mandatory 100% requirements.**  
   [gates.ts:45](C:/Users/jeffm/cda-answer-policy/lib/answer-eval/gates.ts:45) enforces zero wrong answers and zero `incomplete` outcomes, but a wrong clarification/decline action can pass the 95% action threshold. A probe with 19 correct declines and one clarification **passes**. There are no separate gates for truthful declines, clarification options or continuations; numeric fixtures are not evaluated.  
   Credit: clarification options that cannot be checked are honestly marked incomplete; the 95% arithmetic and trend-only severity weights are implemented. Add explicit mandatory-category results, including “not measured,” so partial checks cannot imply full acceptance.

6. **Required reporting correction: held-out and coverage results are pooled.**  
   [run-answer-eval.ts:101](C:/Users/jeffm/cda-answer-policy/scripts/run-answer-eval.ts:101) shows split counts but combines development and held-out outcomes, confusion matrices and gates. Era classification uses only the ending year; relative periods remain unresolved for grouping, and clarification/decline capabilities collapse to generic NIBRS buckets. Unscored counts are shown, but exclusion precedence hides label-status totals behind “another tab.” Report splits separately and distinguish execution coverage from label eligibility. The provisional heading correctly disclaims gating, but its table still says “Gate” and “pass/fail.”

7. **Scope limitation is partly honest; completing the compiler need not block this review correction.**  
   The report explicitly identifies question→reader scope, missing numeric evaluation, and skipped follow-ups/buttons. However, it does **not** execute known plan→compiled result, actual routing/fallback, delivered answer statements, or guidance-button continuations. Call these out together and label current “answers” as plan-level semantic assessments. Today’s reader is used as a candidate, not the answer key—appropriate. The passing test script covers basic comparisons and thresholds, but misses the failures above and runner-level scoring/reporting; add focused regression coverage.

**Necessity check:** Correct false correctness credit, material comparison loss, mandatory gates and split reporting before relying on this runner for acceptance. Compiler, route and continuation implementation can remain deferred with explicit “not measured” status; broader product certification and report polish are unnecessary now.
