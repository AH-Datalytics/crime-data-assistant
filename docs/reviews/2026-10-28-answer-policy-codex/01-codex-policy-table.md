**REVISE**

Reviewed `bf1a99f` against the frozen gold set and local `origin/dev` (`e309cd3`). No files edited. The CSV has the required columns and 27 open rows, but these consolidated corrections are necessary:

1. **P02, P12–P13, D08, D13, D28 misinterpret the answer-format decision.** The [October decision record](C:/Users/jeffm/cda-answer-policy/docs/superpowers/specs/2026-10-28-answer-columns-and-chart-labels.md:7) explicitly distinguishes explanation sentences from table columns and preserves coverage/chart notes. “Fixed sentences only” is not an already-approved rule. Remove that attribution and the claim that removing coverage explanations necessitates P02’s threshold. Otherwise Jeff is being asked to solve an invented conflict.

2. **P13/D13 do not preserve frozen rule 13.** The frozen distinctions include a true zero, something no dataset collects, a place/period outside coverage, and an internal app failure. P13 replaces the failure case with “no records” and says empty cells remain blank without preserving a verified numeric zero. Restore those distinctions; otherwise an app failure can be presented as missing data.

3. **Correct “today” using the active answering paths, not obsolete model instructions.** Concrete discrepancies:
   - **P11:** `origin/dev:lib/nibrs-question-compiler.ts:734–759` declines unsupported explicit victim counts; it does not simply answer property offenses instead.
   - **P18/D05:** the 50,000 staffing minimum survives in `lib/claude.ts`, but the active Historical ranking applies a minimum only when supplied (`lib/historical-question-types.ts:448`; `lib/historical-question-compiler.ts:497`). Model-written Historical queries are blocked.
   - **D27:** `lib/current-question-compiler.ts:489` already joins state figures to the reporting sample. Preserve the October rebuild decision, but do not describe `origin/dev` as universally summing all agencies or claim deployed behavior without deployment evidence.
   - **D21:** the six-offender flash-mob query is a legacy prompt definition, not proof that today’s app executes it.

   These differences change whether Jeff is approving new behavior, retaining behavior, or correcting an implementation gap.

4. **Do not re-ask established rules or mark additions decided.** P14’s central clarification rule is an explicit requirement of this review; P18 repeats frozen rule 5. Carry those forward as decided. Conversely, D08/D13 incorporate the still-open fixed-sentence proposal, and D18 lacks the required decision date. Keep genuinely new presentation choices separate from established policy.

5. **P20 conflicts with frozen rule 5’s explicit requested count.** The gold set requires the requested outer limit—for example, exactly 20. Returning additional tied agencies changes that decision. Preserve the requested count and decide only tie ordering unless Jeff explicitly authorizes reopening the frozen rule.

6. **P25’s conversation-wide “never ask again” conflicts with P14.** A later question can introduce a new unresolved ambiguity even after an earlier clarification. Limit the prohibition to re-asking a choice already resolved for the current request/context. Otherwise the app must guess when materially different readings remain.

7. **Complete the source-selection rule in P01/P08/P16.** State that explicit source wording and required details take precedence over defaults, and that a replacement source must answer the same measure, filters and period. P16 currently selects by time coverage alone; P01’s hate-crime priority also omits D24’s NIBRS-only-details exception. Without this, routing can produce a valid number for a different question.

8. **Make the consequential choices concrete and readable.** D21’s “commercial locations list” does not tell Jeff which locations qualify; P12 promises a sentence list without supplying it. Missing defaults include an unspecified geography and “large city” in P08—both change the population being counted or ranked. Resolve these within the existing table. Replace unexplained internal references such as “N1–N4,” “H1–H3,” and “adapter test” with understandable descriptions or linked test references.

**Necessity check:** Correct these policy/status and factual errors before Jeff uses the table to decide behavior. Preserve unaffected decisions. No implementation work, new test suite, product certification, or additional review pass is needed for this review.
