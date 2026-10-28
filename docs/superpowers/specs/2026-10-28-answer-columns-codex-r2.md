# Codex review r2: answer columns and chart labels plan (2026-10-28)

Reviewer: Codex CLI plugin, read-only, on plan r2 (resumed after a model-capacity stop). Verbatim:

**ACCEPT WITH CHANGES.** R2 resolves much of r1, but the inventory, evidence plumbing, route-order assertion, and staffing semantics need the corrections below before implementation.

Read-only source review on `fix/answer-columns-only-data`. No files changed; no tests or browser fixtures run.

1. **Medium — Add the remaining Historical coverage column.**

   Historical pooled answers still return `years_with_reports`, calculated as `valued.length`: [historical-question-compiler.ts](lib/historical-question-compiler.ts:295). It describes coverage of the requested total, rather than being a requested measure. The revised inventory and explicit annotation list omit it.

   **Exact change:** Add `years_with_reports` to the producer inventory and annotation policy; retain its value as internal coverage evidence. Update its existing assertion in `test-historical-question-types.ts` to check that evidence while preserving the total and missing-year expectations.

   **Consequence if unchanged:** Historical totals continue displaying/exporting an unrequested coverage column. The inventory is therefore not yet complete.

2. **Medium — Make the prompt instruction match the narrow annotation policy.**

   The explicit list correctly preserves `clearance_status` and geographic labels. However, §2’s prompt says “no note, status or coverage column,” reinstating the broad prohibition that r1 rejected. NIBRS legitimately groups results by `clearance_status`.

   **Exact change:** Say “no answer-annotation columns,” explicitly preserving requested substantive categories such as `clearance_status`, and document the staffing exception. Keep the positive and negative fixtures.

   **Consequence if unchanged:** The projection preserves a legitimate category that the prompt has already discouraged the model from returning. The list itself otherwise covers the identified annotation names without the previous wildcard damage, subject to findings 1 and 5.

3. **High — Complete the evidence interfaces and their transport to consumers.**

   Two concrete gaps remain:

   - `ShrCoverageEvidence` contains period strings without place identity. Owned-count plans support multiple cities, and their narratives distinguish missing years **per place**: [shr-count-plan.ts](lib/shr-count-plan.ts:618). Typed SHR coverage also preserves constituent place and period: [shr-question-types.ts](lib/shr-question-types.ts:1495). The proposed flat arrays cannot preserve those distinctions.
   - Adding `cellEvidence` to compiled answers does not deliver it to the “why” explainer. That path constructs its input from `InnerCapture.payload`, `cap.notes`, and `cap.facts`: [why-turn.ts](lib/why-turn.ts:33). Neither the capture nor `WhyAnswerFacts` currently carries the proposed evidence.

   **Exact change:** Specify place-keyed SHR evidence—for example, entries containing `place`, `period`, and the relevant reason—and explicitly cover both `shr-count-plan.ts` and `shr-question-types.ts`. Have execution return the evidence alongside rows; the compiler can return the evidence-query definition. Extend the existing emission-paired `why-scope`/`why-turn` transport so `cellEvidence` reaches `WhyAnswerFacts` without becoming answer columns. Preserve row associations through projection. Define `partialPeriods`’ shape and mapping to the existing chart metadata.

   Also make the deterministic-murder evidence’s `caveat` nullable: the current producer deliberately emits `NULL` when no caveat exists.

   **Consequence if unchanged:** Missing coverage can be attributed to the wrong city, and existing explanations lose the evidence they currently read from rows. Preserving those explanations is compatibility work, not expansion into prose editing.

4. **Medium — Replace the universal finalize/log/emit sequence with the actual route-specific invariant.**

   Projection before finalization is correct. The universal requirement to log before emission does not fit the main streaming query path. It finalizes and emits the result first, then logs once after explanation refinement, retry, or fallback: [query/route.ts](app/api/query/route.ts:3610).

   “Emitted columns and row keys = digest input = logged columns” also overstates existing storage:

   - Query logging stores a row count, not complete result rows.
   - Chart-log columns exist only when there is a chart and are bounded.
   - Digests are bounded and absent in proof-off mode.
   - Embed replay bookkeeping stores the latest action/reason/time, not columns or annotation tags.

   **Exact change:** Require one projected answer before chart reconciliation and every relevant finalization/emission, reused by subsequent logging. Preserve the streaming route’s existing single-log timing. Test equality against **finalization inputs**, then separately verify projected inputs to chart serialization, persisted digest behavior when enabled, and query-log drop tags. For embeds, test projected finalization/emission and unchanged replay bookkeeping; do not require nonexistent persisted column/tag fields.

   **Consequence if unchanged:** Implementation either changes streaming behavior unnecessarily or adds storage/proof behavior solely to satisfy an assertion that existing interfaces cannot meet. JSON-route ordering and the proposed embed projection/reconciliation point otherwise fit.

5. **High, conditional on staffing choice — Define the exception by meaning and constrain substitution.**

   **A is compatible with current numeric behavior.** However, “the `note` renamed” must mean extracting the staffing classification, not renaming every staffing note. Existing notes also include missing staffing, missing population, and change-calculation reasons.

   **B is implementable, but is a substantive behavior change.** Simply changing `staffingReader()` to substitute employees would leave `measure: officers`, officer titles, and potentially officer-rate labels attached to employee values. It also feeds the change compiler, which subtracts the two endpoint values whenever both are present: [historical-question-compiler.ts](lib/historical-question-compiler.ts:520). That could produce an apparent officer change between an officer count and an employee count.

   **Exact change:** After the owner selects A or B, specify:

   - One staffing-only classification column, with defined values; unrelated reasons remain internal evidence.
   - For A, retain blank officer values and convert legacy employee-fallback values to blanks before relabeling them.
   - For B, preserve the actual measure identity in table/CSV/chart labels and define the supported substitution scope. Do not calculate officer changes across unlike endpoint measures or substitute employees for explicitly requested civilians.
   - Keep the classification out of automatic chart-series discovery unless deliberately used as a binding. Projection alone does not make deleting `CHART_METADATA_KEY` safe for this retained text field.

   **Consequence if unchanged:** A can retain general annotations under a new name; B can mislabel employee figures and calculate misleading changes. Neither owner answer is inherently unacceptable, but B needs these semantic rules rather than a simple fallback replacement.

The remaining r1 corrections are sound:

- **Surfaces and replay:** The previously missed rendering/export surfaces and administrative exclusion are now covered. Reconciling stored chart bindings before replay finalization is appropriate.
- **CSV and nulls:** Exporting canonical projected columns in original order preserves constant context and all-null measures. Keeping table folding separate is correct.
- **Browser measurement:** Shared browser measurement, font-ready/resize remeasurement, wrapping without truncation, and actual browser bounds/overlap evidence address r1. Measure the rendered tick font; check SVG ticks and HTML legends in their respective containers. Canvas estimates alone are not the acceptance evidence.
- **Release checks:** Executable expected-change checkers and retained numeric/null/order assertions are appropriate; include the additional Historical coverage-field removal above.

**Necessity check:** Correct the five items above because they prevent annotation leakage, lost evidence, misleading staffing answers, or unnecessary changes to streaming/logging. Preserve the accepted CSV, surface, and browser work. Defer new logging schemas, broad chart certification, font assets, and unrelated explanation edits.

