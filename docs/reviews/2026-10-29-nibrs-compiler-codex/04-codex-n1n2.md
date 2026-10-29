**REVISE** — one blocker at HEAD `ce9b5d9`.

1. **Grouped-year shares return an invalid status for a zero denominator.** [compile.ts:220](C:/Users/jeffm/cda-compiler/lib/nibrs-plan/compile.ts:220) falls back to the rolled count status. With categories observed in 2024 and all twelve 2025 months `REPORTED_ZERO`, execution returns:
   - Count: `0 / REPORTED_ZERO` — correct.
   - Share: `null / REPORTED_ZERO` — incorrect; must be `null / UNAVAILABLE`.

   This violates the result contract and differs from the correct monthly branch. Correct the rollup share-status logic and add this focused regression to the gate.

2. **Category selection and denominators accepted.** N1’s derivation explicitly uses combinations occurring across the whole period. `cats CROSS JOIN` matches that rule. Monthly denominators independently count distinct units; grouped year/total denominators sum each month once per category. Positive rollups, UNKNOWN propagation, and `IS NOT DISTINCT FROM` matching for NULL categories passed execution checks.

3. **Property filters and quoting accepted.** Conditions within each existence filter apply to the same property segment, correlated by the full incident key. Synthetic execution excluded split-segment matches and avoided multiplication from multiple matching segments. The required statement is present. Adversarial alias/literal quoting remained one SQL statement and preserved the alias.

4. **The gate’s N1 construction is faithful to this fixture.** UNKNOWN months expand to blank count/share cells for every category. `MISSING-IN-EXPECTED` causes comparison failure rather than silently supplying zero. Every statistic is compared, with percentage rounding matching the reference’s half-up rule. The current cases simply do not exercise the failing grouped-year branch.

5. **Verification:** Offline tests and comparator self-tests passed. Direct read-only DuckDB execution matched **N1’s 1,484 rows / 2,968 statistic cells**, **N2’s 12 rows**, and **H1 12, H2 1, H3 6, N3 54**, including statuses and required statements. No files edited.

**Necessity check:** Fix the demonstrated zero-denominator rollup status and gate that case before accepting this increment. Preserve all passing evidence; broader capabilities and unrelated hardening are deferred.
