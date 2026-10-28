**REVISE**

Reviewed commit `6023308` against `origin/dev` (`c1f53815`), using `git show origin/dev:<path>`. No files edited. SHR-first and the lighter-compiler approach are reasonable. The note needs these corrections before it can guide engine decisions:

1. **Correct the “fits as is” claims (lines 48, 87, 121).**  
   SHR T4 includes **median and average victim age**, and T2/T5 support count thresholds (`lib/shr-question-types.ts:71–75`). The plan has no median statistic or aggregate-result threshold. RTCI also supports rolling rates, which `validate.ts` P11 expressly rejects. Staffing agency rates conflict with S12: declaring staffing non-additive across agencies currently rejects *every* staffing rate, including a single agency’s rate. Briefly identify these extension points rather than claiming complete expressibility. Otherwise the note understates what the agreed next adapter needs and could inadvertently remove supported answers.

2. **Separate source coverage evidence from result-cell statuses (lines 14, 53–60, 101–102, 179).**  
   `result.ts` has six cell statuses, including `VALUE`, `UNKNOWN_UNEVIDENCED_ZERO`, and `UNAVAILABLE`; it has no `REPORTED_CRIMES` cell status. Describe the four source reporting states separately and map them into this existing result contract.

   More importantly, Return A validation is **not a universal SHR zero rule**. `shr-count-plan.ts:15–18` explicitly says a Return A murder zero cannot establish an all-homicide zero; the accepted city-murder path has its own policy. A Return A/SHR discrepancy also establishes a gap, not necessarily confirmed non-submission. Scope this evidence by measure, geography and annual period; do not imply annual evidence establishes monthly completeness. Otherwise the adapter could manufacture zeros or reporting certainty.

3. **Make G4/G6 preserve the actual staffing contract (lines 93–100).**  
   The fallback is confirmed, but it requires `all_total > 0`; absent staffing remains blank. Also:
   
   - Mixed officer/employee totals currently return the individual years rather than a combined total (`historical-question-compiler.ts:343–359`).
   - Unlike-year comparisons retain both endpoint values, leave changes blank, and set `reported` to null; endpoint types are identified through the measure. They do **not** emit `"Officers to Employees"` (`:580–607`).
   - Use `UNAVAILABLE` with reason `not_comparable`, rather than conflating a reason with a new status.
   
   Explain how one fixed measure unit accommodates the fallback without pretending employee figures count officers. Keep the label exception explicitly limited to Historical officer-fallback answers, including nullable labels and exclusion from chart series. `answer-columns.ts` is already enforced through `proof-finalize.ts`; this is an engine integration requirement, not permission for arbitrary measures to add text columns.

4. **Correct RTCI sample facts and distinguish two different cohort operations (lines 113–138).**  
   `update-rtci-db.py:451–484` builds `national_monthly` from the sample, but builds `state_monthly` from **all agencies**. The typed compiler independently uses the sample for national/state answers.

   Its ordinary multi-month totals require **identical contributor sets** each month. When sets change, it shows monthly values; rolling totals become blank (`current-question-compiler.ts:579–613`). Selecting the intersection of reporting agencies can instead produce a number, so it is not equivalent. Describe sample membership and reporting eligibility separately, preserving the distinction between ordinary totals and fixed-cohort comparisons. A third mutually exclusive enum value cannot itself express both. Also correct the S3 reference: current S3 concerns dimensions; P10 constrains same-agency plans.

5. **Complete the proposed time rules without changing NIBRS resolution (G5/R6, lines 130–135, 177).**  
   R6 must check **comparison endpoints as well as the enclosing period**. Otherwise a whole-year Historical plan could compare January with February and pass the stated rule.

   Per-place YTD also needs a corresponding extension to resolved provenance: `result.ts` currently stores one period and unkeyed comparison pairs. Explain whether prior-year comparison inputs enlarge the selected period or receive a narrowly scoped exception to R2; January-to-current-month alone cannot contain the previous-year operand. Preserve the requested place/offense cutoff—the cited prompt specifies both.

   Finally, `resolve.ts` does not implement `clippedTo`: explicit out-of-release periods fail R1. Mark clipping as source-specific proposed behavior, not an existing shared rule. SHR’s cited annual cutoff also has an explicit-current-year exception, and differs from `latest_calendar_year_in_release` when the release ends in December.

6. **Finish the geography/population boundary and explicitly preserve NIBRS behavior (G7, lines 79–85, 178, 198–204).**  
   “Every measure is a sum” misses Historical’s published national clearance percentages and stored state/national crime rates (`historical-question-compiler.ts:9–16`). “State and national from Census” also contradicts the note’s own SHR CDE-estimate rule. Preserve each source’s existing denominator and published-value policy; NIBRS rates must retain their matched eligible-agency numerator and covered population.

   G7 must acknowledge that published geography values do not naturally fit `SemanticEntity.agencyColumn`, R3’s agency-union semantics, or R4’s requirement for agency members. A brief “published values resolve directly; unsupported combinations are refused” is enough.

   G1, layer-based era bounds and measure grain are sensible directions. Explicitly retain NIBRS’s existing era limits, rate eligibility, cohort behavior and answer statements. In particular, `checkEnvelope` currently requires `"These are reported NIBRS counts."` for **every national plan**; that condition must become source-specific while remaining unchanged for NIBRS.

**Necessity check:** These are note-only corrections needed to avoid misleading adapter choices or changing answer meaning. Keep SHR next and the lighter compilers. Defer implementation, additional investigations and broader certification; no scope growth is needed.
