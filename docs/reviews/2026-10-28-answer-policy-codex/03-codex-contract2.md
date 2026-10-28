**REVISE**

1. **O4 can still be bypassed by omitting request context.** [outcome.ts:43](C:/Users/jeffm/cda-answer-policy/lib/nibrs-plan/outcome.ts:43) silently skips accounting when `request` is absent. The Baltimore→Houston / 2022–2026→2024 alternative still returns no problems with the four-argument call. Require context whenever an alternative is present, or return a validation problem when it is missing. Otherwise, successful validation does not guarantee retained constraints.

2. **Validate retained parts together.** [outcome.ts:44](C:/Users/jeffm/cda-answer-policy/lib/nibrs-plan/outcome.ts:44) calls `validateBindings` separately for each part, losing cross-part context. I reproduced a valid murder-clearance count passing normal accounting but failing O4 because the measure check cannot see the retained `clearance` part. Filter out declared changes, then validate the remaining parts in one call.

3. **Accept the O3 fix.** Descriptive metadata is excluded as requested, and the regression suite passes. Reachability fixtures have no changes in this diff. No files were edited.

**Necessity check:** Both remaining changes are necessary to make O4 enforce accounting without rejecting valid alternatives. O3 is accepted; broader duplicate normalization and unrelated improvements are deferred.
