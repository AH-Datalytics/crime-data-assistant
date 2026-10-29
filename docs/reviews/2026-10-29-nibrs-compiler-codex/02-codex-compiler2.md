**REVISE** — one remaining gate defect at HEAD `749beb1`; the compiler fixes are accepted.

1. **The gate still accepts a positive value marked `REPORTED_ZERO`.** In [nibrs-compile-gate.ts:63](C:/Users/jeffm/cda-compiler/scripts/nibrs-compile-gate.ts:63), consistency checking only tests blank versus nonblank. Numeric expectations then allow either `VALUE` or `REPORTED_ZERO`. Running the actual comparator with `['2025-01', 26, 'REPORTED_ZERO']` and expected value `26` printed **“all equal,” zero failures**. Require `REPORTED_ZERO` to have value exactly `0`, and add this regression check. Otherwise the gate can certify the contradictory evidence identified in the original review.

2. **Compiler corrections accepted.** Conflicts return null with `EVIDENCE_CONFLICT`, propagate through year/total aggregation, and appear in `refuseOn`. States/nation and the specified unsupported forms are refused. Offense identity includes `key_occurrence`. The previously accepted joins, time placement, and quoting remain intact.

3. **Verification passed.** Offline tests passed. Direct Python DuckDB execution confirmed exact rows, values, and statuses for **H1 12/12, H2 1/1, H3 6/6, N3 54/54**. Both synthetic monthly cases matched **5/5**; additional year and total executions correctly propagated refusal. The gate now detects duplicate/extra/missing output rows and resolution problems.

**Necessity check:** Only the gate’s demonstrated `REPORTED_ZERO` consistency hole needs correction now to satisfy the promised evidence check. Preserve the accepted compiler and numerical results; broader testing and capabilities are deferred. No files edited.
