**Verdict: REVISE — one answer-changing defect.**

**Period-comparison results cannot pass the guard.** [result.ts:116](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/result.ts:116) derives permitted columns and evidence counts from `plan.statistics`, ignoring transforms.

Reproduced with the existing `S3` plan:

- Requested `victims.earlier`, `victims.later`, and `victims.change`, with values `[10, 15, 5]` and matching evidence: **rejected**.
- A single `victims` column containing `15`, omitting the requested comparison: **accepted**.

Derive expected columns and evidence identities from the plan’s final outputs after transforms. Add a regression accepting S3’s comparison and rejecting its incomplete single-count result. Align the specification’s “exactly one column” wording accordingly.

The earlier probes now pass: `Availability`, `dataNote`, the annotated header, zero with UNKNOWN evidence, unauthorized statements, and duplicate columns are rejected; `"Exceptional clearance reason"` is accepted. The identified spec contradictions and app-implementation claim are corrected.

The prescribed test command failed with environment `spawn EPERM`. Running the same test file through an in-memory TypeScript transpiler passed all assertions: 35 plans and 6 reader outcomes. No files edited.

**Necessity check:** Fix comparison-output validation because it blocks valid answers and accepts incomplete ones. Preserve the accepted corrections; no broader compiler or UI certification is needed for this review.
