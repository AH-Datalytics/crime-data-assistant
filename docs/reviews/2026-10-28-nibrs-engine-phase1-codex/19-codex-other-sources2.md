**REVISE**

1. **One residual correction from item 3: preserve staffing’s reporting prerequisite.** The revised “The figure” bullet allows a positive `officer_total` even when `all_total` is missing or zero. On `origin/dev`, `historical-question-compiler.ts:195` returns blank unless `all_total > 0`, before choosing either figure. Replace that sentence with:  
   “If `all_total` is missing or nonpositive, return blank; otherwise use positive `officer_total`, falling back to `all_total`.”  
   Leaving it unchanged would describe an adapter that returns numbers where today’s staffing contract returns blanks.

2. **The other five findings are resolved at the requested plan-note level.** The extensions, scoped coverage, RTCI cohort distinction, R6 endpoints, published values and NIBRS preservation are adequately addressed. Confirmed: `clippedTo` exists in `d276b8f:lib/nibrs-plan/resolve.ts`; the branch-versus-`origin/dev` distinction resolves that concern.

**Necessity check:** Only the staffing sentence needs correction to preserve existing behavior. No implementation, further investigation or scope growth is needed. No files edited.
