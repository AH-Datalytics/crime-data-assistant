Plan review (one pass) of the compiler-completion plan r1 (shared notes, compiler-completion-plan.md). r2 applies it; the coordinator agreed r2.

**Recommendation: revise the batching, then proceed with a small delivery increment.** The overall direction and shadow-only boundary are sound. Batch 1 is too large, Batch 3 has unresolved dependencies, and the listed work does not yet cover the full plan language. These are planning corrections; they do not justify reopening the accepted compiler or reader work.

This was a read-only review. No files changed, and I did not rerun numerical evaluations.

1. **Make the first increment delivery of the already-accepted N1/N2 forms.**

   Extend category columns, shares, labels, blank handling, and required statements through [deliver.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/deliver.ts) and [answer.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-shadow/answer.ts). Both currently assume one count; `measureWords` also uses only the first measure.

   Reuse the accepted N1/N2 numerical evidence and add fresh end-to-end cases. The [compiler review record](C:/Users/jeffm/cda-compiler/docs/reviews/2026-10-29-nibrs-compiler-codex/README.md) already accepts those calculations. Requiring new raw-file reconstruction of identical computations would add little.

   Charts can follow tables. The existing chart description has an x column and y columns, but no category-series binding; merely enabling it would risk connecting different categories into one series.

2. **Split the remainder of Batch 1 into separately gated capabilities, without requiring a separate PR/review ceremony for each.**

   | Capability | Essential gate before enabling it | Consequence without it |
   |---|---|---|
   | Multiple measures and independent filters | Per-measure, per-cell D6 evidence; one measure positive while another is unevidenced, zero, or unknown | A positive measure can incorrectly “prove” another measure’s zero |
   | Multi-value dimensions and relationships | Distinct counted units per category; independent denominator; paired attributes reached through the same relationship row | Join multiplication, invented relationship/age combinations, or incorrect shares |
   | FBI composite | Independent component counts in their own units, then sum; component status propagation | Deduplicating across components undercounts; counting everything as victims or offenses miscounts |
   | Arrests | Arrest-date attribution, record identity, cross-year reads, and applicable reporting evidence | Arrests appear in the incident year or inherit crime-report completeness they do not establish |
   | Clearances | Explicit temporal meaning and numerator/denominator definitions | A cohort’s eventual clearance share is presented as a period clearance rate |

   These distinctions already exist in [plan.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/plan.ts:149), [semantic.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/semantic.ts:45), and [validate.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/validate.ts:219). Validation protects shape and declared relationships; it does not prove executable counting semantics.

   For multi-value shares, the denominator must count each unit once at `within` grain, so displayed shares can sum above 100%. `PAIRED_RELATIONSHIP` counts victims; `PAIR_COUNT` counts pairs. They need different expected values, not just different labels. Age-bin cases should include unknown/special codes and values outside supplied bins.

   D19 also needs an explicit combined drug-crime measure or equivalent aggregation: displaying drug/narcotic and equipment violations side by side does not alone answer “how many drug crimes?”

3. **Resolve time semantics before clearance and mixed arrest answers—not by silently expanding the schema.**

   The plan has **one global `timeBasis`**. [MULTI_MEASURE](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/examples.ts:161) inherits incident date for robberies, robbery victims, and arrests, whereas the proposed batch promises arrests by arrest date. Those are different answers. For now, support separately labelled compatible plans and refuse mixed-basis requests that cannot be represented. Per-measure time bases would be a separate scope decision.

   Similarly, [CLEARANCE_RATE](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/examples.ts:182) is an incident-date **ratio**, not a population rate. Decide whether the delivered answer means:

   - offenses occurring in the selected period that are recorded as cleared; or
   - clearances occurring during that period divided by offenses occurring during that period.

   The latter requires independently timed components that the current global basis cannot directly express. Establish what the canonical records support and how arrest versus exceptional clearance is attributed; if the intended measure cannot be established, keep it refused. Do not treat “an arrest exists” as sufficient proof of the intended clearance measure.

4. **Keep time work next, but separate simple year selection/comparisons from rolling.**

   Noncontiguous years and single-agency comparisons are reasonable early increments. Gate matched months, missing-month propagation, zero baselines, and percentage-change availability. D06 names partial periods; **D17** supplies the prohibition on change claims across mismatched periods.

   [resolve.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/resolve.ts:103) checks comparison containment and release coverage, but does not itself establish comparable reporting periods.

   Rolling deserves its own gate: complete calendar windows, gaps, leading-window behavior, and recomputation of shares/ratios from their parts. Never average monthly percentages. Retain the existing refusals for rolling rates and rolling-plus-comparison. This makes Batch 2 manageable; calling it “small” before these distinctions is premature.

5. **Split Batch 3 into named-place counts, population rates, and rankings.**

   Separate named agencies can reuse single-agency results and can precede rates. Combined places need deduplicated membership **and aggregation of D6 evidence**; that dependency cannot wait until states/nation.

   Rates require more than “agency population by year.” [plan.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/plan.ts:180) requires complete-period eligible agencies, matching numerator/population membership, and covered-population handling. It also distinguishes observed counts from eligible counts. Gate missing/zero population, secondary-without-primary coverage, changing membership, and partial periods.

   There is a policy discrepancy to settle before rate expectations are frozen: **P15 preserves a months-weighted reporting-population rule**, while the language specifies complete-period eligibility. Obtain a narrow owner ruling on that difference; do not quietly choose either interpretation. D03 already decides demographic population rates; no need to reopen it.

   Rankings need their own gate for eligibility, unknown values, exclusions, and the “include incomplete reporters” button. **P17 requires exactly N, alphabetical within ties**, whereas [plan.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/plan.ts:222) says ties at the cutoff are retained. Follow the decided policy.

   Counties need **P25’s county-police exception**, not D10 alone. The shared crosswalk’s relevant identity/population evidence may therefore be needed in Batch 3. Its entire universal rollout need not be.

6. **Correct the completion inventory and example mapping.**

   The plan omits or underspecifies:

   - Property sums, vehicles, and average value; [PROPERTY_VALUE](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/examples.ts:231) requires D23 placeholder exclusions without changing counts.
   - General attribute operators, negated/scoped existence filters, and measure-local filters.
   - Share-only outputs, arbitrary supported `within` scopes, explicit denominators, and `absent: omit`.
   - Supported transform combinations and geography groupings.

   Explicitly assign these to a batch or defer them; otherwise call this an expansion, not compiler completion.

   Several cited examples also exceed their proposed batch: `CLEARANCE_BREAKDOWN` is statewide, `RANKED_RATES` ranks states, and `COMBINED_PLACES` combines Maryland and Baltimore. Create agency-only development variants while retaining the originals for the later gates.

   Some examples encode superseded reader behavior: H1 supplies a missing period, and MULTI_MEASURE asks for robbery victims despite P11. Keep structural compiler fixtures distinct from current-policy reader expectations.

7. **Keep the gates, with two practical clarifications.**

   Independent raw-file values first, a canonical cross-check, frozen held-out cases, recursive button checking, and shadow-only delivery are the right foundation. Pin the release, semantic definitions, policy, and relevant crosswalk version with the expected evidence. Compare status and denominator/cohort evidence as well as numbers: matching positive totals can conceal wrong zeros or eligibility.

   **Zero wrong answers is necessary but insufficient to demonstrate completion.** A batch that declines everything can pass that condition. Predeclare the forms it must actually answer correctly, alongside valid refusals. Any reachable unchecked numerical answer makes verification incomplete—not a verified pass. This preserves the distinction already accepted in the [shadow-slice review](C:/Users/jeffm/cda-compiler/docs/reviews/2026-10-29-nibrs-shadow-slice-codex/04-codex-slice4.md).

   Freeze cases outside the implementation feedback loop; after inspection, retain them as regression evidence. Use fresh held-out cases for newly enabled semantics, not repeated wholesale relabelling of accepted work.

   The answer contract also needs incremental extensions. [result.ts](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/result.ts) currently authorizes only three fixed statements; it does not yet cover multi-value overlap, ranking exclusions, or population coverage. Check text, charts, and exported values too—`checkEnvelope` alone does not certify their correctness.

For states and the nation, retain the final position, but cite **P03/D22** for participation and coverage; P02 concerns source tabs. Gate all-reporting totals separately from the consistent-agency option, including measure-specific cohort membership. Apply P18’s state-clearance refusal and P01 source routing rather than treating every valid NIBRS plan as an appropriate default answer.

**What I would defer:** rolling initially; arbitrary combinations of newly added features; mixed-time-basis answers; property sums if not needed next; category charts until their series mapping is correct; broad agency-set rankings until geographic and denominator evidence is available. Keep each explicitly unsupported rather than weakening correctness.

**Necessity check:** Now, narrow the first increment to accepted breakdown delivery and record the later semantic gates and omitted forms. Resolve clearance/mixed-time meaning before enabling those answers, and the P15 denominator discrepancy before rates. Existing numerical evidence can support the first increment; no additional plan-review round or broad product certification is necessary. Defer the capabilities above, preserving the accepted work and existing correction allowance.
