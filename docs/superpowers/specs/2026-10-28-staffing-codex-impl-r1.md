# Codex implementation review r1: staffing, phase 2 (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only, on committed contents. Verbatim:

**ACCEPT WITH CHANGES.** Reviewed committed contents at `f195b29` against `7d902e5`; no files edited or tests run. The reported 82/82 and 22/22 results do not cover the gaps below. References are to committed line numbers.

1. **High — Changes still identify employee figures as officers and misclassify unlike-endpoint answers.**  
   [historical-question-compiler.ts:581](lib/historical-question-compiler.ts:581) retains `measure: officers` and officer-only titles/explanations, including when **both endpoints are Employees**. Unlike endpoints produce `"Officers to Employees"`, outside the specified classification values. Additionally, [query/route.ts:2249](app/api/query/route.ts:2249) ignores endpoint values: an unlike-endpoint answer with two valid figures receives `no_rows_in_source`, and `returnedEntities` is empty.

   **Exact fix:** Give endpoints their actual measure identity using the agreed endpoint-specific display or separate-period rows; preserve blank differences across unlike endpoints. Name employee-to-employee changes correctly. Count delivered endpoint figures in outcome/entity accounting. Test table, CSV and route outcome for both cases.  
   **Consequence:** Valid employee figures remain presented as officers, and valid source observations are logged as absent.

2. **High — Mixed pooled totals discard the annual figures; employee-only totals retain officer-only titles.**  
   [historical-question-compiler.ts:342](lib/historical-question-compiler.ts:342) correctly suppresses a mixed sum, but emits only a blank aggregate row. The specification requires retaining annual figures. Lines 386 and 404 also construct officer-only wording even when the entire computed total comprises employees.

   **Exact fix:** Return the classified annual figures when a combined total is unavailable; correct total titles/explanations for employee contributions. Align delivered-series accounting with what is actually returned. Replace the test permitting either `1500` **or null** with the exact expected total.  
   **Consequence:** The requested fallback loses available data, while a homogeneous employee total can still be called sworn officers.

3. **High — Pivoted tooltip classification is looked up using the display name instead of the series key.**  
   [ChartPanel.tsx:91](components/ChartPanel.tsx:91) searches `${name}::reported`, but Line/Bar supply `name={properCase(y)}`. The pivot stores classification under the original key. For “officers and civilians,” `officers_or_employees::reported` therefore cannot be found using `"Officers Or Employees::reported"`.

   **Exact fix:** Look up classification using the tooltip item’s raw `dataKey`; format the visible series name separately. Use the required staffing measure wording rather than generic `"Value"` or mechanically title-cased identifiers. Test the formatter/rendered tooltip after a measure pivot, plus two agencies with different classifications.  
   **Consequence:** The pivot preserves classification internally but the displayed tooltip loses it.

4. **High — Legacy reconciliation and prompt examples remain incomplete.**  
   [answer-columns.ts:65](lib/answer-columns.ts:65) renames only `data_type`. It leaves `staffing`, saved titles and axis labels unchanged; discriminator-free legacy comparisons pass through unchanged. The prompt at [claude.ts:863](lib/claude.ts:863) still mandates officer-only rate numerators and labels, while its wide comparison substitutes employees without classification. Its `COALESCE` examples also retain zero officers while marking the row Employees.

   **Exact fix:** Complete the supported legacy pair transformation and reconcile bindings, titles and labels. For discriminator-free comparisons, reconstruct verified classification where supported or return the specified targeted limitation. Update the existing prompt examples to select the same numerator and classification, including zero-officer fallback and officers-only substitution.  
   **Consequence:** Old embeds and remaining taught SQL shapes can still display employees as officers or calculate inconsistent rates.

5. **Medium — Staffing rate labels lose their units and measure identity.**  
   [historical-question-compiler.ts:403](lib/historical-question-compiler.ts:403) replaces the entire rate phrase with `"officers or total employees"` when substitution occurs. [table-display.ts:58](lib/table-display.ts:58) does not support staffing’s `per_1000`/`per_100k` statistics; constant measure/statistic fields are subsequently hidden, leaving `"Value"`.

   **Exact fix:** Preserve the denominator in mixed-measure titles and add friendly table labels for both staffing rate statistics. Verify a single employee-year rate and a mixed annual rate series.  
   **Consequence:** A correctly calculated rate can appear without its measure or denominator.

Accepted: reader/ranking numerator selection, minimum-population filtering order, blank no-population cells/classifications, and suppression of mixed sums/unlike differences. The projection identity checks also correctly propagate rename-only changes through both finalization and emission; I found no columns/rows equality defect there.

**Necessity check:** Correct these answer-meaning, display and accounting failures before acceptance, with focused regression cases. Preserve the accepted arithmetic and projection work; defer broad chart certification, unrelated accounting changes and a general legacy-SQL migration framework.

