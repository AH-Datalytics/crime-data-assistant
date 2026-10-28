# Codex review r1: answer columns and chart labels plan (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only, on plan r1. Verbatim:

**ACCEPT WITH CHANGES.** The direction is sound, but the inventory is incomplete and several proposed simplifications would lose data or break existing behavior.

Reviewed the code at `a9256a3` on `fix/answer-columns-only-data`. No files changed; this was source inspection, not execution of tests or browser fixtures.

1. **High — Expand the producer inventory and migrate their internal consumers.**

   Missed result columns include:

   - `note` in Current’s `COLUMNS` and returned rows: [current-question-compiler.ts](lib/current-question-compiler.ts:36).
   - `note` in Historical series, pooled results, and changes: [historical-question-compiler.ts](lib/historical-question-compiler.ts:335).
   - `note` in NIBRS `SERIES`, `BREAKDOWN`, `SHARE`, and `CHANGE`: [nibrs-question-compiler.ts](lib/nibrs-question-compiler.ts:40).
   - `periods_without_records` across SHR count, share, and age shapes: [shr-question-types.ts](lib/shr-question-types.ts:1224). This also escapes the proposed forbidden vocabulary.

   These are not all display-only. NIBRS `typedChartConfig()` reads `row.note` to reject partial-period charts and compares complete column arrays against schema constants; `seriesTitle()` parses partial-year notes. [why-answers.ts](lib/why-answers.ts:356) reads notes to explain missing reports, sample participation, and missing population.

   **Exact plan change:** Add these producers and consumers to §2. Move necessary evidence into internal fields before removing result columns, updating chart-schema comparisons and “why” consumers together. Otherwise the implementation either leaves notes in results or changes chart eligibility, titles, and explanations.

2. **High — Replace the blanket name rule with a narrowly scoped annotation rule.**

   `*_status` would remove legitimate requested categories. The NIBRS prompt explicitly teaches `SELECT race, clearance_status, SUM(victim_count) AS victims … GROUP BY race, clearance_status`: [nibrs-claude.ts](lib/nibrs-claude.ts:837). Removing that grouping leaves indistinguishable rows with different meanings.

   Likewise, `jurisdiction_label`, `agency_label`, and `place_label` occur in builders as geographic identities, not editorial annotations. “Never a label column” is too broad. Conversely, the proposed matcher misses `shr_recorded_months`, so old embed SQL can still leak it.

   **Exact plan change:** Define prohibited *answer annotations*, preserve substantive grouping labels/status categories, and explicitly cover `periods_without_records` and the legacy SHR coverage fields. Include both positive and negative fixtures.

   Dropping a known, redundant annotation is preferable to refusing an otherwise valid answer. Do not silently drop a grouping or the discriminator for mixed measures; those need source correction or a targeted compatibility transformation.

3. **High — Preserve all-null measures and make CSV independent of heading reconstruction.**

   The plan misdescribes existing behavior. [table-display.ts](lib/table-display.ts:86) drops empty optional metadata; it deliberately retains all-null result measures. Dropping every empty column could erase `officers`, a requested rate, or an uncomputable change precisely when its blank values matter.

   Also, `shown + heading` cannot reconstruct a complete CSV. `tableDisplay()` absorbs measure/unit/statistic into friendly headers, suppresses place when already in the title, and omits some internal constants from its returned heading list.

   **Exact plan change:** Retain requested all-null measures in tables and CSV. Derive CSV columns from the canonical permitted result columns in original order, preserving grouping/measure context even when represented by a title or friendly header onscreen. Keep table folding as a presentation decision. No further owner confirmation is necessary to preserve constant CSV groupings.

4. **High — Specify one projected result shared by proof, logging, chart configuration, and delivery.**

   “Before digest and logging” is correct but insufficiently concrete. `finalizeProof()` passes rows and columns into proof checks and the digest; SQL derivation separately fingerprints SQL. The digest is bounded evidence, **not** a complete binding between emitted payload and proof. `emitFactualPayload()` does not compare their rows.

   Existing routes generally finalize and log **before** `jsonResp()`/`sseEvent()`. Filtering there would be too late. Filtering only inside finalization would leave the response unchanged.

   **Exact plan change:** Specify the sequence: collect internal evidence → construct permitted answer rows/columns → construct or reconcile chart bindings → finalize proof → log → emit that same projected answer. Apply the answer contract regardless of proof mode, without changing proof mode semantics.

   Add an integration assertion comparing emitted columns/row keys with digest input and logged leak tags. For embeds, use the existing replay bookkeeping: [embed/route.ts](app/api/embed/route.ts:280) explicitly does not write a query-log row per read.

5. **High — Complete the surface and replay inventory.**

   Missed paths are:

   - `NibrsChartPanel`, used by NIBRS, SHR, and embeds, with its own sizing and series logic.
   - `lib/chart-config.ts`, `lib/nibrs-chart-config.ts`, and NIBRS `typedChartConfig()`, which choose chart columns before rendering.
   - `WorkspaceChat_restore.tsx`, another `ExportButtons` caller.
   - `app/chart-audit-preview/preview-client.tsx`, another chart-rendering entry.
   - Image download/copy and embed-link creation within `ExportButtons`; their correctness depends on the rendered chart and saved configuration.
   - `app/api/query-log/route.ts` POST returns raw replay rows/columns. This is an administrative inspection path; explicitly exclude it from the user-answer contract rather than silently overlooking it.

   **Exact plan change:** Add these to the inventory, distinguishing active answer surfaces from administrative/diagnostic ones. Preserve chart-required axes and grouping keys rather than assuming table-visible columns alone suffice.

   Test an old stored embed whose SQL returns removed columns **and whose stored chart configuration references them**. Filter replay rows before proof, reconcile the saved axes/series, and preserve chart notes. Do not delete `CHART_METADATA_KEY` until every rendering entry uses the shared policy.

6. **Medium — Make the SHR evidence migration concrete and preserve unknown-year coverage.**

   `annualCoverageValues` is currently a local SQL-values **string**, not evidence exposed by `ShrMurderPlan`: [shr-deterministic-murder.ts](lib/shr-deterministic-murder.ts:49). The plan must add structured coverage evidence to the internal plan interface.

   `shr-count-plan.ts` does not currently have the sibling’s `coverageSql` interface. Its pooled narratives read `years_without_records`; population explanations read `population_status`. Preserve those facts through explicit internal evidence.

   The owned-count route’s unknown-period tag currently uses numeric counts, including special handling for undefined ratios: [shr-query/route.ts](app/api/shr-query/route.ts:1336). Removing `shr_records` alone does not break that path.

   **Exact plan change:** Name the evidence interfaces and retain tests for missing periods, pooled missing years, valid zero, zero-denominator ratios, conflicting/missing population, and partial-year rates. Keep requested period rows and existing accounting semantics; do not replace them with a generic “blank means unknown” assumption.

7. **Medium — Separate the obsolete staffing prompt from active staffing behavior.**

   Historical’s active deterministic compiler already distinguishes officers from employees and returns a blank officer value when only employees were reported: [historical-question-compiler.ts](lib/historical-question-compiler.ts:190). Historical model SQL is blocked by request accounting.

   **Exact plan change:** Correct the legacy `data_type` prompt examples, but state that this alone does not change active staffing answers. Preserve existing requested-measure semantics; implement two numeric columns where replacing an actual mixed staffing result, without automatically adding unrequested employee counts. If old staffing embeds must be supported, explicitly transform their `staffing`/`data_type` pairs before dropping the discriminator.

8. **High — Replace the font-table guarantee with browser measurement and honest test boundaries.**

   Both chart panels use 13px DM Sans ticks with Segoe UI/Arial fallbacks. [layout.tsx](app/layout.tsx:56) loads DM Sans remotely with `display=swap`. Summed character advances cannot guarantee rendered bounds across fallback fonts, kerning/shaping, SVG transforms, and Recharts tick placement.

   Node tests can verify computed layout arithmetic. They cannot verify actual rendered SVG boxes. Legends also render outside the SVG, so “every label inside the SVG” is not the right assertion for them.

   **Exact plan change:** Prefer one shared browser text-measurement/wrapping helper for both panels, remeasured after font loading and resize. Remove hard line truncation, account for formatted numeric ticks, and let layout height grow while preserving plot space and notes.

   Keep Node layout tests, but perform actual bounds/overlap checks in a browser at 375/768/1280px **before release**, either with a small automated browser fixture or recorded manual inspection. Browser CI is optional; actual rendering evidence is not. A committed glyph table is unnecessary for the shortest defensible fix.

9. **Medium — Strengthen focused guards and spell out release expectations.**

   Existing tests explicitly assert removed fields, including `test-shr-count-plan.ts`, `test-shr-deterministic-murder.ts`, `test-shr-question-types.ts`, `test-historical-question-types.ts`, and `test-nibrs-typed-chart.ts`. Update their evidence assertions while preserving numeric/null expectations.

   The static “no `response.columns`” guard is too syntactic: renaming a variable bypasses it, while passing raw input into a component that internally projects safely can be legitimate. Prefer behavior tests of the shared projection and representative route/render/export paths.

   O352 and H1–H3 exercise compiler shapes containing `note`; removing it changes even answers whose notes are entirely null. [release-checks.cjs](scripts/release-checks.cjs:125) requires expected-change entries to name fields **and an executable checker**.

   **Exact plan change:** Require checkers that confirm intended column removal and preserve expected numeric values, periods, row order, and chart semantics. Do not broadly mask `rows` without validating their retained contents. Add fixtures for all-null measures, legitimate `clearance_status`, old embed replay, partial-year chart evidence, CSV context, and retained chart notes.

The hate-crime prompt should be explicitly included in the shared prompt rule; I found no comparable annotation-output example there or in the SHR prompt. Their narrative caveats are separate from result columns.

**Necessity check:** Revise the plan now to cover missed producers/consumers, preserve grouping and null semantics, establish projection ordering, handle replay, and require real browser evidence for label fit. These prevent concrete answer or measurement failures. Defer a font-metrics asset pipeline, broad chart certification, new-engine integration as a release dependency, and a separate decision about removing explanatory prose.

