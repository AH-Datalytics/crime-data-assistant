# Codex implementation review r3: staffing, phase 2 (2026-10-28)

Reviewer: Codex CLI plugin (codex-companion task), read-only, on committed contents. Verbatim:

**ACCEPT.** Reviewed `702f644..64b587d` and relevant committed consumers. No files edited or tests run.

All three r2 findings are resolved:

- Endpoint headers now preserve officer/employee identity and rate denominators; the regression test exercises the actual compiled answer through `tableDisplay()`.
- Staffing prompt selection, ranking availability, gap classification and labels now follow the officers-only fallback rule.
- Marked legacy answers reconcile officer-only titles and axis labels. Retaining the neutral `staffing` binding is sufficient; finalization and emission still receive equal projected columns/rows.

The previously accepted exception for the 17 discriminator-free legacy answers remains in scope as a known limitation.

**Necessity check:** No further changes are necessary for acceptance. Preserve the accepted implementation and reported test evidence; defer legacy SQL reconstruction and unrelated polish.

