**Verdict: REVISE.** All requested regression probes now pass, but three answer-changing gaps remain. The overall structure does not need another redesign.

Reviewed HEAD `a3dc0066d4d6bbaceb24d999274512ed756d94a3` and `HEAD~1..HEAD`. The supplied suite passes: **35 plans and 6 reader outcomes**. No files were edited.

| Previous required change | R3 assessment |
|---|---|
| 1. Value-based accounting | Original probes fixed; broader restrictions and wrong rate scales still pass |
| 2. Consistent code/era validation | Met |
| 3. Noncontiguous-period validation | Met |
| 4. Strict reader schemas | Met |
| 5. Executable semantic link lookup | Met |
| 6. Transform targeting and aggregation | Mostly met; rate gating and repeated comparisons remain defective |
| 7. Correct acceptance examples | Met |

The rerun confirms:

- Texas → Maryland, female → `not_in F`, month → year, and immigration status → question are rejected.
- `dollars` is accepted.
- Invalid and era-invalid plain-filter codes are rejected.
- `since 2010` with a code introduced in 2020 is rejected after resolution.
- `[2019,2024]` with a 2020 comparison is rejected.
- Unsupported `negate: true` is rejected rather than stripped.
- Ranking a compared statistic without selecting its output is rejected; explicit `count.pct_change` works.

**Remaining required changes:**

1. **Accounting still accepts changed populations, scales and agency identities.**  
   [validate.ts:325](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:325)

   These additional probes returned **no problems**:

   | Requested part | Accepted binding |
   |---|---|
   | `sex:F` | `in: ["F","M"]` |
   | `per100k` | Rate with `per: 10` |
   | Baltimore, MD | Houston ORI `TXHPD0000`, carrying a fabricated Baltimore label |

   The filter check tests membership rather than equivalence. Statistic accounting checks only `kind`. Agency accounting trusts the model-supplied label, including its state suffix.

   **Required:** validate the complete normalized restriction, the requested rate multiplier, and authoritative resolved geography identity. Use explicit normalized mappings for legitimate multi-code families; do not treat “contains the requested code” as sufficient. A display label must not establish an ORI’s identity.

   **Consequence if unchanged:** the gate approves counts for a broader population, rates differing by a factor of 10,000, or another city’s records. This is the remaining portion of requirement 1.

2. **P14 both admits undefined multi-year rates and rejects valid partial-year rates.**  
   [validate.ts:66](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:66) and [validate.ts:172](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:172)

   Demonstrated:
   - A 2023–2025 plan comparing **count**, while also outputting an ungrouped **rate**, passes. Any comparison disables P14, even when it does not target that rate.
   - An ungrouped rate `since: "2026-01"` is rejected as multi-year before resolution, although the release can resolve it to January–October 2026. `last_n` months has the same conservative classification problem.

   **Required:** enforce the one-data-year rule **per rate statistic**. Exempt only rates actually evaluated through qualifying comparison periods. For relative periods, make the decision after resolving their actual bounds.

   **Consequence if unchanged:** the compiler either invents a multi-year population denominator or refuses an explicitly permitted elapsed-period rate.

3. **Multiple comparisons can overwrite the same output identities.**  
   [validate.ts:152](C:/Users/jeffm/crime-data-assistant/.claude/worktrees/nibrsai-engine-03b73d/lib/nibrs-plan/validate.ts:152)

   Two comparisons of `count`—2023→2025 and 2024→2025—both pass. Both produce identifiers such as `count.change`; `compared.set()` retains only the last comparison’s output list. A subsequent rank cannot identify which change it means.

   **Required:** the smallest fix is to reject overlapping statistic targets across comparison transforms. Alternatively, give each comparison uniquely addressable outputs. Add a focused rejection test.

   **Consequence if unchanged:** an accepted plan has ambiguous result columns and ranking semantics.

No additional optional work is requested. The semantic interface, strict schemas, denominator aggregation clarification, selected-year handling and corrected examples can remain accepted.

**Necessity check:** only the three demonstrated failures above must be fixed before treating validation as the compiler’s trusted boundary. Preserve the accepted changes; defer SQL implementation, broad testing and product certification. The shortest route is exact normalized binding checks, per-statistic resolved rate validation, and rejection of duplicate comparison targets.
