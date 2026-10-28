# Codex implementation review r2: staffing, phase 2 (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only, on committed contents. Verbatim:

**ACCEPT WITH CHANGES.** Reviewed `f195b29..702f644` using committed contents only. No edits or tests run.

The pooled-total fix, endpoint outcome accounting, raw-key tooltip lookup, and staffing rate headers resolve their substantive r1 issues. Three gaps remain:

1. **High — Unlike-endpoint identity still disappears from the displayed table.**  
   [historical-question-compiler.ts:603](lib/historical-question-compiler.ts:603) puts the endpoint identities in `measure`, but [table-display.ts:101](lib/table-display.ts:101) folds that field even for one row, and line 142 removes it from the displayed constants. Since change rows have no `value` column, it is not absorbed into a header either. CSV retains the identity; the table does not.

   **Exact fix:** Preserve this endpoint-specific measure in the table, or apply endpoint-specific headers. Include rate denominators where applicable. Add a `tableDisplay()` assertion using the actual unlike-endpoint compiler result—not merely an assertion that `rows[0].measure` contains the words.

   **Consequence:** The displayed endpoint numbers remain indistinguishable as officer versus employee figures despite the correct blank change.

2. **High — The rewritten prompt still contradicts the selection rule.**  
   [claude.ts:841](lib/claude.ts:841) applies officer fallback to **“ALL staffing queries.”** The ranking example still filters `hs.officer_total > 0`, excluding precisely the employee-only agencies it now knows how to select. Other instructions still mandate officer-only axis labels and returning `officer_total` directly.

   **Exact fix:** Restrict fallback instructions to officer requests; preserve explicit civilian/employee measures. Change the ranking availability predicate to `all_total > 0`, retain the population minimum, and remove contradictory direct-officer instructions and officer-only labels. Make gap rows’ `reported` null.

   **Consequence:** These examples still teach omitted employee-only rankings, incorrect measure labels, and substitution outside the authorized scope. This is completion of r1’s existing prompt finding, not a new prompt audit.

3. **Medium — Marked legacy answers still retain unreconciled measure names and chart labels.**  
   [answer-columns.ts:65](lib/answer-columns.ts:65) remains unchanged: it maps `data_type` to `reported`, but leaves the numeric binding, saved title and axis labels untouched. This is separate from the 17 discriminator-free answers.

   **Exact fix:** For the supported `staffing`/`data_type` pair, complete the agreed numeric-name/binding transformation and reconcile staffing titles/axis labels using the classification already available. Keep finalization and emission on the same projected columns/rows. Add one marked legacy fixture with an officer-only saved title and axis label.

   **Consequence:** A supported legacy employee figure can still appear beneath an officer-only chart label. No SQL reconstruction is needed for this case.

I accept deferring reconstruction of the **17 discriminator-free legacy answers** as the explicit pre-existing limitation you describe; I have not independently verified that inventory. That is a bounded exception to the original legacy requirement, not evidence those answers are correctly labeled. It does not justify leaving the supported, marked legacy path unfinished.

“Total total employees” and the broader mixed wording on employee-only change titles are awkward but do not warrant another blocker.

**Necessity check:** Fix the hidden endpoint identity, contradictory staffing examples, and marked-legacy labels because they still affect answer meaning. Preserve the accepted calculations and tests. Defer discriminator-free SQL reconstruction, cosmetic wording, and broad chart certification.

