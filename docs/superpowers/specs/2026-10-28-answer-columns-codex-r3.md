# Codex review r3: answer columns and chart labels plan (2026-10-28)

Reviewer: Codex CLI plugin, read-only, on plan r3. Verbatim:

**ACCEPT WITH CHANGES.** R3 resolves r2’s annotation-list and prompt findings, and substantially resolves evidence transport and projection ordering. Staffing option B is workable, but several existing paths still need explicit treatment.

Read-only source review on `fix/answer-columns-only-data`; no files changed or tests run.

1. **High — Preserve complete SHR coverage information, not just exceptions.**

   The new evidence correctly includes place and period. However, its reason-only shape loses the distinction between **some cells missing** and **all cells missing**.

   Today, `coverageSql` returns every constituent-place/period combination, including `has_records: 1`. `shrQuestionOutcome()` uses that complete grid to decide whether all coverage is missing. See [shr-question-types.ts](lib/shr-question-types.ts:1213) and [the outcome consumer](lib/shr-question-types.ts:1520). An array containing only `no_records` exceptions cannot support that decision by itself.

   **Exact change:** Retain the existing complete coverage grid alongside the new issue evidence, or include `hasRecords` for every expected constituent-place/period cell. Preserve constituent identity rather than replacing it with the aggregate answer-place label. Add one mixed-present/missing fixture and one entirely-missing fixture.

   **Consequence if unchanged:** A partially covered answer can incorrectly receive the statement that SHR has no records for the whole place and period.

2. **High — Apply staffing selection to rankings/lists before rate calculation and ordering.**

   The plan’s “Where” list misses `compileRank()`. That path does not call `staffingReader()`; it independently selects staffing counts, calculates rates, excludes unavailable values, sorts, and emits officer measure labels. See [historical-question-compiler.ts](lib/historical-question-compiler.ts:422).

   **Exact change:** Include `compileRank()` explicitly. Use the same officer-versus-employee selection before availability filtering, rate calculation, sorting, and limiting. Carry `reported` through the selected entries and use the mixed-measure wording in ranking/list titles and labels.

   For both reader and ranking paths, specify the rate as:

   `selected staffing count × requested scale / that agency’s population for that year`

   Keep missing/nonpositive population blank and preserve existing minimum-population rules. Do not select an employee numerator while retaining the SQL’s precomputed officer rate.

   Add count-ranking and rate-ranking fixtures where substitution changes the order, plus a missing-population case.

   **Consequence if unchanged:** Rankings can omit employee-only agencies contrary to option B, or rank substituted figures using the wrong rate while calling the result officers.

3. **High — Define staffing results that contain multiple measures or periods.**

   The single `reported` value works for an ordinary annual row. It does not yet cover these existing shapes:

   - **Pooled totals:** the series compiler sums all non-null annual cells. With B, that can combine officers and employees into one number that cannot truthfully be classified as either. See [the pooled branch](lib/historical-question-compiler.ts:326).
   - **Changes:** H6 puts both endpoint values in one row. Leaving the difference blank is correct, but one `reported` cell cannot identify unlike endpoint figures.
   - **Explicit civilians or multiple staffing measures:** “Officers/Employees” and the proposed universal `officers_or_employees` label must not overwrite an explicitly requested civilian measure or collapse separate requested measures.

   **Exact change:** Restrict the mixed-measure alias to officer-request results. Preserve explicit employee/civilian measure identity. For pooled officer totals, compute a total only when contributing figures share a classification; otherwise retain the annual figures and state that a combined total is unavailable. For unlike H6 endpoints, identify each endpoint’s actual measure through endpoint-specific labels or separate period rows while retaining only one classification column. Keep the change blank.

   Add pooled-mixed, unlike-endpoint display/CSV, and officers-plus-civilians fixtures.

   **Consequence if unchanged:** The implementation can sum unlike quantities or display endpoint/civilian figures under an inaccurate measure identity despite correctly suppressing the change.

4. **High — Preserve staffing classification through chart pivots and legacy replay.**

   Excluding `reported` from series discovery is necessary, but insufficient. `detectAndPivotChartData()` rebuilds rows using only the X value and each series’ numeric value; it discards the original classification. Two agencies can report different kinds in the same year. See [chart-layout.ts](lib/chart-layout.ts:106).

   The legacy embed transform also covers only `staffing`/`data_type` pairs. Existing prompt examples include wide Chicago/NYPD fallback columns **without any discriminator**: [claude.ts](lib/claude.ts:882).

   **Exact change:** Preserve classification keyed by period **and series** through pivoting, and have tooltips read that association. For supported legacy pairs, reconcile saved titles, series names, and axis labels as well as column bindings. For discriminator-free legacy staffing comparisons, reconstruct classification from verified source data where supported; otherwise return a targeted compatibility limitation rather than inventing “Officers” classifications.

   Add a two-agency chart fixture with different classifications in the same year, and legacy embed fixtures with and without `data_type`.

   **Consequence if unchanged:** Live comparison tooltips lose measure identity, and old embeds can continue presenting employee counts as officers.

5. **Medium — Remove the remaining contradictory ordering and validation requirements.**

   Section 3 now correctly preserves streaming timing and tests the interfaces that actually exist. Section 6 still requires “emitted = digest = logged,” which r2 explicitly replaced.

   Section 6 also says numeric/null expectations and chart bindings remain unchanged without exempting owner-authorized staffing changes. B deliberately changes some nulls, values, rankings, and bindings.

   **Exact change:** Replace the stale Ordering bullet with a reference to Section 3’s assertions. State that non-staffing values remain unchanged, while staffing fixtures and release checkers validate the specifically authorized substitution, classification, and comparison rules.

   **Consequence if unchanged:** Implementation acceptance remains internally contradictory and can encourage unnecessary logging changes or incorrect preservation of old staffing expectations.

The other r2 corrections are accepted: `years_with_reports` is covered; prompt wording preserves substantive categories; the emission-paired `cellEvidence` transport through `InnerCapture` and `WhyAnswerFacts` is implementable; nullable murder caveats and the partial-period shape fit the code. CSV constant/all-null preservation and browser measurement requirements remain sound.

**Necessity check:** Resolve the coverage-grid and staffing-path gaps now because they affect answer meaning and calculations; reconcile the contradictory test bullets so implementation has one acceptance standard. No additional logging schema, broad legacy-SQL migration framework, browser CI, or unrelated prose work is necessary.

